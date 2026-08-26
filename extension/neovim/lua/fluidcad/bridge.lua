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
        vim.diagnostic.reset(ns)
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

--- Locate the buffer for `file_path` (or fall back to the current one),
--- POST the buffer text through `editor(code_api, code)`, and replace the
--- buffer with the returned `newCode`. `editor` returns the decoded JSON
--- response from the server, or nil to skip.
function M.apply_code_edit(file_path, editor)
  local code_api = require('fluidcad.code_api')

  local buf = nil
  if file_path then
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_loaded(b) and vim.api.nvim_buf_get_name(b) == file_path then
        buf = b
        break
      end
    end
    -- A named target that isn't loaded yet (cross-file edits: the assembly
    -- mate dialog writing a connector() into a PART file) must be loaded,
    -- never silently swapped for the current buffer — that would splice the
    -- transform into the wrong file.
    if not buf then
      if vim.fn.filereadable(file_path) ~= 1 then
        vim.notify('FluidCAD: cannot edit ' .. file_path .. ' — file not readable', vim.log.levels.ERROR)
        return
      end
      buf = vim.fn.bufadd(file_path)
      vim.fn.bufload(buf)
    end
  end
  if not buf then
    buf = vim.api.nvim_get_current_buf()
  end

  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local code = table.concat(lines, '\n')

  local result = editor(code_api, code)
  if not result or type(result.newCode) ~= 'string' then
    return
  end
  if not code_api.replace_buffer(buf, result.newCode) then
    return
  end

  -- TextChanged autocmd does not fire for non-current buffers, so push the
  -- live-update explicitly. A cross-file edit (the mate dialog writing into
  -- a PART buffer while the assembly is current) is marked keepCurrent so
  -- the server folds it in as a dependency instead of switching the
  -- viewport to the edited file.
  M.send({
    type = 'live-update',
    fileName = vim.api.nvim_buf_get_name(buf),
    code = result.newCode,
    keepCurrent = (buf ~= vim.api.nvim_get_current_buf()),
  })
end

function M.handle_message(msg)
  vim.schedule(function()
    if msg.type == 'ready' then
      server_url = msg.url
      -- Announce the host before the browser UI can connect — the server
      -- relays the capabilities to the UI, which shows its editor-backed
      -- controls (undo/redo) only for hosts that declared them.
      M.send({
        type = 'editor-hello',
        editor = 'neovim',
        capabilities = { undoRedo = true },
      })
      if config.open_browser and server_url then
        -- Neovim *is* the editor here, so the page renders viewport-only: no
        -- code pane, no tabs, no in-page host competing with this bridge for
        -- the same buffer.
        local viewer_url = M.viewer_url()
        local cmd
        if vim.fn.has('mac') == 1 then
          cmd = { 'open', viewer_url }
        elseif vim.fn.has('wsl') == 1 then
          cmd = { 'cmd.exe', '/c', 'start', viewer_url }
        else
          cmd = { 'xdg-open', viewer_url }
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
      M.update_diagnostics(msg.result, msg.compileError)
    elseif msg.type == 'error' then
      local full = msg.message or 'unknown'
      for sub in ('[error] ' .. full .. '\n'):gmatch('([^\n]*)\n') do
        table.insert(log_lines, sub)
      end
      local first_line = full:match('%S[^\n]*') or 'unknown error'
      vim.notify('[fluidcad] ' .. first_line .. '  (:FluidCadLog for details)', vim.log.levels.ERROR)
      local current_path = vim.api.nvim_buf_get_name(vim.api.nvim_get_current_buf())
      if current_path and current_path ~= '' then
        M.update_diagnostics({}, { message = full, filePath = current_path })
      end
    elseif msg.type == 'import-complete' then
      if msg.success then
        vim.print('[fluidcad] File imported successfully')
      end
    elseif msg.type == 'insert-point' then
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.insert_point(code, msg.sourceLocation.line, msg.point)
      end)
    elseif msg.type == 'add-pick' then
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.add_pick(code, msg.sourceLocation.line)
      end)
    elseif msg.type == 'remove-pick' then
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.remove_pick(code, msg.sourceLocation.line)
      end)
    elseif msg.type == 'add-guide' then
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.add_guide(code, msg.sourceLocation.line)
      end)
    elseif msg.type == 'remove-guide' then
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.remove_guide(code, msg.sourceLocation.line)
      end)
    elseif msg.type == 'remove-point' then
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.remove_point(code, msg.sourceLocation.line, msg.point)
      end)
    elseif msg.type == 'set-pick-points' then
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.set_pick_points(code, msg.sourceLocation.line, msg.points)
      end)
    elseif msg.type == 'update-insert-chain' then
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.update_insert_chain(code, msg.sourceLocation.line, msg.edit)
      end)
    elseif msg.type == 'insert-geometry' then
      local new_var = msg.newVariable
      if new_var == vim.NIL then
        new_var = nil
      end
      M.apply_code_edit(msg.sketchSourceLocation.filePath, function(code_api, code)
        return code_api.insert_geometry(code, msg.sketchSourceLocation.line, msg.statement, new_var)
      end)
    elseif msg.type == 'insert-load' then
      M.apply_code_edit(msg.filePath, function(code_api, code)
        return code_api.insert_load(code, msg.fileName)
      end)
    elseif msg.type == 'update-sketch-positions' then
      M.handle_update_sketch_positions(msg)
    elseif msg.type == 'apply-feature-edit' then
      M.apply_code_edit(msg.spec and msg.spec.filePath, function(code_api, code)
        local result = code_api.apply_feature(code, msg.spec)
        if result and result.error and result.error ~= vim.NIL then
          vim.notify('[fluidcad] ' .. result.error, vim.log.levels.ERROR)
          return nil
        end
        return result
      end)
    elseif msg.type == 'update-dimension' then
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.update_dimension(code, msg.sourceLocation.line, msg.newValue)
      end)
    elseif msg.type == 'update-dimension-expression' then
      local new_var = msg.newVariable
      if new_var == vim.NIL then
        new_var = nil
      end
      local sketch_line = msg.sketchSourceLine
      if sketch_line == vim.NIL then
        sketch_line = nil
      end
      local dim_offset = msg.dimensionOffset or 0
      M.apply_code_edit(msg.sourceLocation.filePath, function(code_api, code)
        return code_api.update_dimension_expression(
          code, msg.sourceLocation.line, msg.expression,
          sketch_line, new_var, dim_offset
        )
      end)
    elseif msg.type == 'remove-feature' then
      M.apply_code_edit(msg.filePath, function(code_api, code)
        return code_api.remove_statement(code, msg.line)
      end)
    elseif msg.type == 'rename-feature' then
      M.apply_code_edit(msg.filePath, function(code_api, code)
        return code_api.set_feature_name(code, msg.line, msg.name)
      end)
    elseif msg.type == 'add-breakpoint' then
      local ok, breakpoints = pcall(require, 'fluidcad.breakpoints')
      if ok and msg.filePath and msg.line then
        breakpoints.add_after(msg.filePath, msg.line)
      end
    elseif msg.type == 'goto-source' then
      local ok, navigation = pcall(require, 'fluidcad.navigation')
      if ok and msg.filePath and msg.line then
        navigation.goto_source(msg.filePath, msg.line, msg.column or 0)
      end
    elseif msg.type == 'clear-breakpoints' then
      local ok, breakpoints = pcall(require, 'fluidcad.breakpoints')
      if ok then
        -- The active .fluid.js buffer is the target; fall back to the
        -- current buffer when lookup by path fails.
        local path = vim.api.nvim_buf_get_name(vim.api.nvim_get_current_buf())
        breakpoints.clear_all(path)
      end
    elseif msg.type == 'undo' or msg.type == 'redo' then
      M.handle_undo_redo(msg)
    end
  end)
end

local function find_buffer_for_path(file_path)
  if not file_path then
    return nil
  end
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(b) and vim.api.nvim_buf_get_name(b) == file_path then
      return b
    end
  end
  return nil
end

local is_fluid_script = require('fluidcad.file_kind').is_fluid_script

--- Server-driven editor history: run native undo/redo inside the buffer for
--- `msg.filePath` and ack the outcome. Deliberately no current-buffer
--- fallback — stepping history in whatever buffer happens to be focused
--- could rewind an unrelated file.
function M.handle_undo_redo(msg)
  local err = nil
  local buf = find_buffer_for_path(msg.filePath)
  if not buf then
    err = 'no buffer for ' .. tostring(msg.filePath)
  elseif not is_fluid_script(vim.api.nvim_buf_get_name(buf)) then
    err = 'refusing to ' .. msg.type .. ' a non-fluid buffer'
  else
    local tick_before = vim.api.nvim_buf_get_changedtick(buf)
    local ok, cmd_err = pcall(vim.api.nvim_buf_call, buf, function()
      vim.cmd('silent ' .. msg.type)
    end)
    if not ok then
      err = tostring(cmd_err)
    elseif vim.api.nvim_buf_get_changedtick(buf) == tick_before then
      err = 'Nothing to ' .. msg.type .. '.'
    else
      -- TextChanged does not fire for non-current buffers; push explicitly.
      local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
      M.send({
        type = 'live-update',
        fileName = vim.api.nvim_buf_get_name(buf),
        code = table.concat(lines, '\n'),
      })
    end
  end
  M.send({ type = 'edit-ack', editId = msg.editId, error = err })
end

--- Solved-sketch batch position write-back (sketch-rewrite P4): one buffer
--- write (one undo block) covering every drifted statement of a drag; the
--- transform's outcome — including drift refusals — rides back over the IPC
--- edit-ack so the waiting HTTP request answers honestly.
function M.handle_update_sketch_positions(msg)
  local code_api = require('fluidcad.code_api')
  local ack = function(err)
    if msg.editId and msg.editId ~= vim.NIL then
      M.send({ type = 'edit-ack', editId = msg.editId, error = err })
    end
  end

  local file_path = msg.filePath
  if file_path == vim.NIL then
    file_path = nil
  end
  local buf = find_buffer_for_path(file_path)
  if not buf and file_path then
    -- A named target that isn't loaded must be loaded, never silently
    -- swapped for the current buffer (same rule as apply_code_edit).
    if vim.fn.filereadable(file_path) ~= 1 then
      ack('cannot edit ' .. file_path .. ' — file not readable')
      return
    end
    buf = vim.fn.bufadd(file_path)
    vim.fn.bufload(buf)
  end
  if not buf then
    buf = vim.api.nvim_get_current_buf()
  end

  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local code = table.concat(lines, '\n')
  local result = code_api.update_sketch_positions(code, msg.edits)
  if not result or type(result.newCode) ~= 'string' then
    ack('the code transform request failed')
    return
  end
  if result.error and result.error ~= vim.NIL then
    ack(result.error)
    return
  end
  if not code_api.replace_buffer(buf, result.newCode) then
    ack('the editor rejected the buffer edit')
    return
  end
  M.send({
    type = 'live-update',
    fileName = vim.api.nvim_buf_get_name(buf),
    code = result.newCode,
    keepCurrent = (buf ~= vim.api.nvim_get_current_buf()),
  })
  ack(nil)
end

function M.update_diagnostics(result, compile_error)
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

  if compile_error then
    local loc = compile_error.sourceLocation
    local fp = (loc and loc.filePath) or compile_error.filePath
    if fp then
      if not by_file[fp] then
        by_file[fp] = {}
      end
      table.insert(by_file[fp], {
        lnum = math.max(0, ((loc and loc.line) or 1) - 1),
        col = math.max(0, ((loc and loc.column) or 1) - 1),
        message = compile_error.message,
        severity = vim.diagnostic.severity.ERROR,
        source = 'FluidCAD',
      })
    end
  end

  -- clear diagnostics for all buffers in this namespace
  vim.diagnostic.reset(ns)

  for fp, diagnostics in pairs(by_file) do
    local bufnr = find_buffer_for_path(fp)
    if bufnr then
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

--- The URL to show a human: the same page with its code editor turned off.
--- Neovim owns the buffer, so an in-page editor would be a second host over
--- the same file. `?editor=0` also hides the tab strip and the menu's editor
--- entry.
function M.viewer_url()
  if not server_url then
    return nil
  end
  local separator = server_url:find('?', 1, true) and '&' or '?'
  return server_url .. separator .. 'editor=0'
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
