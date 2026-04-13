local bridge = require('fluidcad.bridge')

local M = {}

--- Split any entries that contain embedded newlines into separate lines
--- so that nvim_buf_set_lines never receives a string with '\n'.
local function flatten_lines(lines)
  local out = {}
  for _, line in ipairs(lines) do
    for sub in (line .. '\n'):gmatch('([^\n]*)\n') do
      table.insert(out, sub)
    end
  end
  return out
end

function M.setup(_config)
  vim.api.nvim_create_user_command('FluidCadStart', function()
    bridge.start(vim.fn.getcwd())
  end, { desc = 'Start the FluidCAD server' })

  vim.api.nvim_create_user_command('FluidCadStop', function()
    bridge.stop()
  end, { desc = 'Stop the FluidCAD server' })

  vim.api.nvim_create_user_command('FluidCadUrl', function()
    local url = bridge.get_url()
    if url then
      vim.fn.setreg('+', url)
      vim.print('[fluidcad] ' .. url .. '  (copied to clipboard)')
    else
      vim.print('[fluidcad] Server not ready yet')
    end
  end, { desc = 'Show server URL and copy to clipboard' })

  vim.api.nvim_create_user_command('FluidCadOpenBrowser', function()
    local url = bridge.get_url()
    if not url then
      vim.notify('[fluidcad] Server not ready yet', vim.log.levels.WARN)
      return
    end
    local cmd
    if vim.fn.has('mac') == 1 then
      cmd = { 'open', url }
    elseif vim.fn.has('wsl') == 1 then
      cmd = { 'cmd.exe', '/c', 'start', url }
    else
      cmd = { 'xdg-open', url }
    end
    vim.fn.jobstart(cmd, { detach = true })
  end, { desc = 'Open FluidCAD URL in default browser' })

  vim.api.nvim_create_user_command('FluidCadProcessFile', function()
    local file = vim.fn.expand('%:p')
    if not file:match('%.fluid%.js$') then
      vim.notify('[fluidcad] Current file is not a .fluid.js file', vim.log.levels.WARN)
      return
    end
    bridge.when_ready(function()
      bridge.send({ type = 'process-file', filePath = file })
    end)
  end, { desc = 'Process current .fluid.js file' })

  vim.api.nvim_create_user_command('FluidCadRollback', function(opts)
    local index = tonumber(opts.args)
    if not index then
      vim.api.nvim_echo({{ '[fluidcad] Usage: :FluidCadRollback <index>', 'ErrorMsg' }}, true, {})
      return
    end
    bridge.send({
      type = 'rollback',
      fileName = vim.fn.expand('%:p'),
      index = index,
    })
  end, { nargs = 1, desc = 'Rollback to operation index' })

  vim.api.nvim_create_user_command('FluidCadImport', function(opts)
    local filepath = opts.args
    if filepath == '' then
      vim.api.nvim_echo({{ '[fluidcad] Usage: :FluidCadImport <path>', 'ErrorMsg' }}, true, {})
      return
    end
    filepath = vim.fn.expand(filepath)
    if vim.fn.filereadable(filepath) == 0 then
      vim.api.nvim_echo({{ '[fluidcad] File not found: ' .. filepath, 'ErrorMsg' }}, true, {})
      return
    end
    local data = vim.fn.readfile(filepath, 'b')
    local raw = table.concat(data, '\n')
    local encoded = vim.base64.encode(raw)
    local filename = vim.fn.fnamemodify(filepath, ':t')
    bridge.send({
      type = 'import-file',
      workspacePath = vim.fn.getcwd(),
      fileName = filename,
      data = encoded,
    })
  end, { nargs = 1, complete = 'file', desc = 'Import a STEP file' })

  vim.api.nvim_create_user_command('FluidCadLog', function()
    vim.cmd('botright new')
    local buf = vim.api.nvim_get_current_buf()
    local win = vim.api.nvim_get_current_win()
    vim.bo[buf].buftype = 'nofile'
    vim.bo[buf].bufhidden = 'wipe'
    vim.bo[buf].swapfile = false
    vim.bo[buf].modifiable = false
    vim.api.nvim_buf_set_name(buf, '[fluidcad server log]')

    -- Populate with existing logs
    local logs = bridge.get_logs()
    if #logs > 0 then
      vim.bo[buf].modifiable = true
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, flatten_lines(logs))
      vim.bo[buf].modifiable = false
    end

    -- Scroll to bottom
    local line_count = vim.api.nvim_buf_line_count(buf)
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_set_cursor(win, { line_count, 0 })
    end

    -- Subscribe to new log lines
    local function on_new_logs(lines)
      if not vim.api.nvim_buf_is_valid(buf) then
        bridge.unsubscribe_logs(on_new_logs)
        return
      end
      vim.bo[buf].modifiable = true
      vim.api.nvim_buf_set_lines(buf, -1, -1, false, flatten_lines(lines))
      vim.bo[buf].modifiable = false
      -- Auto-scroll any window showing this buffer
      for _, w in ipairs(vim.api.nvim_list_wins()) do
        if vim.api.nvim_win_is_valid(w) and vim.api.nvim_win_get_buf(w) == buf then
          local lc = vim.api.nvim_buf_line_count(buf)
          vim.api.nvim_win_set_cursor(w, { lc, 0 })
        end
      end
    end

    bridge.subscribe_logs(on_new_logs)

    -- Unsubscribe when the buffer is wiped
    vim.api.nvim_create_autocmd('BufWipeout', {
      buffer = buf,
      once = true,
      callback = function()
        bridge.unsubscribe_logs(on_new_logs)
      end,
    })
  end, { desc = 'Show streaming server logs in a scratch buffer' })
end

return M
