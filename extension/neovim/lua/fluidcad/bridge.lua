local M = {}

local job_id = nil
local server_url = nil
local ready = false
local pending_callbacks = {}
local config = {}
local log_lines = {}
local log_subscribers = {}

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
          vim.api.nvim_echo({{ '[fluidcad] Server exited with code ' .. code, 'ErrorMsg' }}, true, {})
        end
      end)
    end,
    stdout_buffered = false,
    stderr_buffered = false,
  })

  if job_id <= 0 then
    vim.api.nvim_echo({{ '[fluidcad] Failed to start bridge', 'ErrorMsg' }}, true, {})
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
        table.insert(log_lines, '[init-error] ' .. full)
        local first_line = full:match('%S[^\n]*') or 'unknown error'
        vim.api.nvim_echo({{ '[fluidcad] Init failed: ' .. first_line .. '  (:FluidCadLog for details)', 'ErrorMsg' }}, true, {})
      end
    elseif msg.type == 'error' then
      local full = msg.message or 'unknown'
      table.insert(log_lines, '[error] ' .. full)
      local first_line = full:match('%S[^\n]*') or 'unknown error'
      vim.api.nvim_echo({{ '[fluidcad] ' .. first_line .. '  (:FluidCadLog for details)', 'ErrorMsg' }}, true, {})
    elseif msg.type == 'import-complete' then
      if msg.success then
        vim.print('[fluidcad] File imported successfully')
      end
    end
  end)
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
