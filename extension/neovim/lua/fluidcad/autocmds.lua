local bridge = require('fluidcad.bridge')
local breakpoints = require('fluidcad.breakpoints')

local M = {}

function M.setup(config)
  local group = vim.api.nvim_create_augroup('FluidCadPlugin', { clear = true })

  local pending_timer = nil
  local last_sent_code = {}
  local last_sent_file = nil

  local function cancel_pending()
    if pending_timer then
      vim.fn.timer_stop(pending_timer)
      pending_timer = nil
    end
  end

  -- Dirty-buffer tracking. Snapshots every `.fluid.js` buffer with `&modified`
  -- set and ships the list to the server so the MCP source-editing tools can
  -- refuse to clobber unsaved work. Mirrors the VSCode extension.
  local last_dirty_signature = nil

  local function snapshot_dirty_files()
    local files = {}
    local seen = {}
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_loaded(buf) then
        local name = vim.api.nvim_buf_get_name(buf)
        if name ~= ''
          and name:match('%.fluid%.js$')
          and vim.bo[buf].modified
          and not seen[name]
        then
          seen[name] = true
          table.insert(files, name)
        end
      end
    end
    return files
  end

  local function send_dirty_state()
    if not bridge.is_running() then
      return
    end
    local files = snapshot_dirty_files()
    table.sort(files)
    local signature = table.concat(files, '\0')
    if signature == last_dirty_signature then
      return
    end
    last_dirty_signature = signature
    bridge.send({
      type = 'editor-dirty-state',
      dirtyFiles = files,
    })
  end


  local function send_live_update_now()
    cancel_pending()
    local buf = vim.api.nvim_get_current_buf()
    local name = vim.api.nvim_buf_get_name(buf)
    if not name:match('%.fluid%.js$') then
      return
    end
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    local code = table.concat(lines, '\n')
    if name == last_sent_file and last_sent_code[name] == code then
      return
    end
    last_sent_file = name
    last_sent_code[name] = code
    bridge.send({
      type = 'live-update',
      fileName = name,
      code = code,
    })
  end

  local function send_live_update_debounced()
    cancel_pending()
    pending_timer = vim.fn.timer_start(50, function()
      pending_timer = nil
      vim.schedule(send_live_update_now)
    end)
  end

  -- Auto-start server when opening a .fluid.js file
  vim.api.nvim_create_autocmd('BufEnter', {
    group = group,
    pattern = '*.fluid.js',
    callback = function()
      if config.auto_start and not bridge.is_running() then
        bridge.start(vim.fn.getcwd())
      end
      if bridge.is_running() then
        bridge.when_ready(function()
          send_live_update_now()
          send_dirty_state()
        end)
      end
      breakpoints.refresh()
    end,
  })

  -- Refresh breakpoint signs after buffer edits
  vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'BufReadPost' }, {
    group = group,
    pattern = '*.fluid.js',
    callback = function(args)
      breakpoints.refresh(args.buf)
    end,
  })

  -- Live-update when leaving insert mode (insert → normal)
  vim.api.nvim_create_autocmd('ModeChanged', {
    group = group,
    pattern = 'i:n',
    callback = function()
      if not bridge.is_running() then
        return
      end
      send_live_update_debounced()
    end,
  })

  -- Live-update on undo/redo in normal mode
  vim.api.nvim_create_autocmd('TextChanged', {
    group = group,
    pattern = '*.fluid.js',
    callback = function()
      if not bridge.is_running() then
        return
      end
      send_live_update_debounced()
    end,
  })

  -- Process file on save
  vim.api.nvim_create_autocmd('BufWritePost', {
    group = group,
    pattern = '*.fluid.js',
    callback = function()
      if bridge.is_running() then
        bridge.send({ type = 'process-file', filePath = vim.fn.expand('%:p') })
      end
      send_dirty_state()
    end,
  })

  -- Keep the server's dirty-buffer set in sync with the editor. The list of
  -- dirty files only changes when a buffer's `&modified` flag flips, so
  -- BufModifiedSet is the right trigger — wiring this to TextChanged/
  -- TextChangedI would re-snapshot every buffer on every keystroke and
  -- starve the live-render path.
  vim.api.nvim_create_autocmd({ 'BufModifiedSet', 'BufDelete', 'BufWipeout' }, {
    group = group,
    pattern = '*.fluid.js',
    callback = function()
      vim.schedule(send_dirty_state)
    end,
  })

  -- Clean up on exit
  vim.api.nvim_create_autocmd('VimLeavePre', {
    group = group,
    callback = function()
      bridge.stop()
    end,
  })
end

return M
