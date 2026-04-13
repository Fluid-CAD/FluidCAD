local M = {}

local job_id = nil
local server_url = nil
local ready = false
local pending_callbacks = {}
local config = {}
local log_lines = {}
local log_subscribers = {}

local ns = vim.api.nvim_create_namespace('fluidcad')

function M.setup(cfg)
  config = cfg
end

function M.start(workspace_path)
  if job_id then
    vim.notify('[fluidcad] Server already running', vim.log.levels.WARN)
    return
  end

  workspace_path = workspace_path or vim.fn.getcwd()

  local cmd = { 'node', config.bridge_path, workspace_path }

  job_id = vim.fn.jobstart(cmd, {
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line ~= '' then
          local ok, msg = pcall(vim.fn.json_decode, line)
          if ok and msg then
            M.handle_message(msg)
          end
        end
      end
    end,
    on_stderr = function(_, data)
      local new_lines = {}
      for _, line in ipairs(data) do
        if line ~= '' then
          table.insert(log_lines, line)
          table.insert(new_lines, line)
        end
      end
      if #new_lines > 0 then
        vim.schedule(function()
          for _, cb in ipairs(log_subscribers) do
            cb(new_lines)
          end
        end)
      end
    end,
    on_exit = function(_, code)
      vim.schedule(function()
        job_id = nil
        server_url = nil
        ready = false
        pending_callbacks = {}
        if code ~= 0 then
          vim.notify('[fluidcad] Server exited with code ' .. code, vim.log.levels.ERROR)
        end
      end)
    end,
    stdout_buffered = false,
    stderr_buffered = false,
  })

  if job_id <= 0 then
    vim.notify('[fluidcad] Failed to start bridge', vim.log.levels.ERROR)
    job_id = nil
  end
end

function M.stop()
  if job_id then
    vim.fn.jobstop(job_id)
    job_id = nil
    server_url = nil
    ready = false
    pending_callbacks = {}
    log_lines = {}
    vim.print('[fluidcad] Server stopped')
  end
end

function M.send(msg)
  if not job_id then
    vim.notify('[fluidcad] Server not running', vim.log.levels.WARN)
    return
  end
  local encoded = vim.fn.json_encode(msg) .. '\n'
  vim.fn.chansend(job_id, encoded)
end

function M.handle_message(msg)
  vim.schedule(function()
    if msg.type == 'ready' then
      server_url = msg.url
      if config.open_browser and server_url then
        local cmd
        if vim.fn.has('mac') == 1 then
          cmd = { 'open', server_url }
        elseif vim.fn.has('wsl') == 1 then
          cmd = { 'cmd.exe', '/c', 'start', server_url }
        else
          cmd = { 'xdg-open', server_url }
        end
        vim.fn.jobstart(cmd, { detach = true })
      end
    elseif msg.type == 'init-complete' then
      if msg.success then
        ready = true
        vim.print('[fluidcad] Server ready at ' .. (server_url or '?'))
        for _, cb in ipairs(pending_callbacks) do
          cb()
        end
        pending_callbacks = {}
      else
        local full = msg.error or 'unknown'
        for sub in ('[init-error] ' .. full .. '\n'):gmatch('([^\n]*)\n') do
          table.insert(log_lines, sub)
        end
        local first_line = full:match('%S[^\n]*') or 'unknown error'
        vim.notify('[fluidcad] Init failed: ' .. first_line .. '  (:FluidCadLog for details)', vim.log.levels.ERROR)
      end
    elseif msg.type == 'scene-rendered' then
      M.update_diagnostics(msg.result)
    elseif msg.type == 'error' then
      local full = msg.message or 'unknown'
      for sub in ('[error] ' .. full .. '\n'):gmatch('([^\n]*)\n') do
        table.insert(log_lines, sub)
      end
      local first_line = full:match('%S[^\n]*') or 'unknown error'
      vim.notify('[fluidcad] ' .. first_line .. '  (:FluidCadLog for details)', vim.log.levels.ERROR)
    elseif msg.type == 'import-complete' then
      if msg.success then
        vim.print('[fluidcad] File imported successfully')
      end
    elseif msg.type == 'insert-point' then
      local line_idx = msg.sourceLocation.line - 1
      local file_path = msg.sourceLocation.filePath

      -- Find the buffer matching the source file
      local buf = nil
      if file_path then
        for _, b in ipairs(vim.api.nvim_list_bufs()) do
          if vim.api.nvim_buf_is_loaded(b) then
            local name = vim.api.nvim_buf_get_name(b)
            if name == file_path then
              buf = b
              break
            end
          end
        end
      end
      if not buf then
        buf = vim.api.nvim_get_current_buf()
      end
      local line_count = vim.api.nvim_buf_line_count(buf)
      if line_idx < 0 or line_idx >= line_count then
        return
      end
      local line_text = vim.api.nvim_buf_get_lines(buf, line_idx, line_idx + 1, false)[1]
      local point_text = string.format('[%s, %s]', msg.point[1], msg.point[2])

      -- Find last ')' on this line
      local close_paren = nil
      for i = #line_text, 1, -1 do
        if line_text:sub(i, i) == ')' then
          close_paren = i
          break
        end
      end
      if not close_paren then
        return
      end

      -- Find matching '(' before it
      local open_paren = nil
      for i = close_paren - 1, 1, -1 do
        if line_text:sub(i, i) == '(' then
          open_paren = i
          break
        end
      end
      if not open_paren then
        return
      end

      local between = line_text:sub(open_paren + 1, close_paren - 1)
      local prefix = ''
      if between:match('%S') then
        prefix = ', '
      end

      -- Insert before the closing paren (0-indexed col for nvim_buf_set_text)
      vim.api.nvim_buf_set_text(buf, line_idx, close_paren - 1, line_idx, close_paren - 1, { prefix .. point_text })

      -- TextChanged autocmd won't fire for non-current buffers, so send live-update explicitly
      local updated_lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
      local code = table.concat(updated_lines, '\n')
      M.send({
        type = 'live-update',
        fileName = vim.api.nvim_buf_get_name(buf),
        code = code,
      })
    elseif msg.type == 'set-pick-points' then
      local line_idx = msg.sourceLocation.line - 1
      local file_path = msg.sourceLocation.filePath

      local buf = nil
      if file_path then
        for _, b in ipairs(vim.api.nvim_list_bufs()) do
          if vim.api.nvim_buf_is_loaded(b) then
            local name = vim.api.nvim_buf_get_name(b)
            if name == file_path then
              buf = b
              break
            end
          end
        end
      end
      if not buf then
        buf = vim.api.nvim_get_current_buf()
      end
      local line_count = vim.api.nvim_buf_line_count(buf)
      if line_idx < 0 or line_idx >= line_count then
        return
      end
      local line_text = vim.api.nvim_buf_get_lines(buf, line_idx, line_idx + 1, false)[1]

      -- Find last ')' on this line
      local close_paren = nil
      for i = #line_text, 1, -1 do
        if line_text:sub(i, i) == ')' then
          close_paren = i
          break
        end
      end
      if not close_paren then
        return
      end

      -- Find matching '(' before it
      local open_paren = nil
      for i = close_paren - 1, 1, -1 do
        if line_text:sub(i, i) == '(' then
          open_paren = i
          break
        end
      end
      if not open_paren then
        return
      end

      -- Build the new arguments string
      local parts = {}
      for _, p in ipairs(msg.points) do
        table.insert(parts, string.format('[%s, %s]', p[1], p[2]))
      end
      local new_args = table.concat(parts, ', ')

      -- Replace content between parens (Lua 1-indexed → nvim 0-indexed)
      -- open_paren is 1-indexed position of '(', so open_paren converts to 0-indexed col after '('
      -- close_paren is 1-indexed position of ')', so close_paren-1 is 0-indexed col of ')'
      vim.api.nvim_buf_set_text(buf, line_idx, open_paren, line_idx, close_paren - 1, { new_args })

      local updated_lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
      local code = table.concat(updated_lines, '\n')
      M.send({
        type = 'live-update',
        fileName = vim.api.nvim_buf_get_name(buf),
        code = code,
      })
    end
  end)
end

function M.update_diagnostics(result)
  local by_file = {}

  for _, obj in ipairs(result) do
    if obj.hasError and obj.errorMessage and obj.sourceLocation then
      local fp = obj.sourceLocation.filePath
      if not by_file[fp] then
        by_file[fp] = {}
      end
      table.insert(by_file[fp], {
        lnum = math.max(0, obj.sourceLocation.line - 1),
        col = math.max(0, obj.sourceLocation.column - 1),
        message = obj.errorMessage,
        severity = vim.diagnostic.severity.ERROR,
        source = 'FluidCAD',
      })
    end
  end

  -- clear diagnostics for all buffers in this namespace
  vim.diagnostic.reset(ns)

  for fp, diagnostics in pairs(by_file) do
    local bufnr = vim.fn.bufnr(fp)
    if bufnr ~= -1 then
      vim.diagnostic.set(ns, bufnr, diagnostics)
    end
  end
end

function M.when_ready(callback)
  if ready then
    callback()
  else
    table.insert(pending_callbacks, callback)
  end
end

function M.get_url()
  return server_url
end

function M.is_running()
  return job_id ~= nil
end

function M.get_logs()
  return log_lines
end

function M.subscribe_logs(callback)
  table.insert(log_subscribers, callback)
end

function M.unsubscribe_logs(callback)
  for i, cb in ipairs(log_subscribers) do
    if cb == callback then
      table.remove(log_subscribers, i)
      return
    end
  end
end

return M
