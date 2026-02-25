local bridge = require('fluidcad.bridge')

local M = {}

function M.setup(config)
  local group = vim.api.nvim_create_augroup('FluidCadPlugin', { clear = true })

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
           local buf = vim.api.nvim_get_current_buf()
               local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
               local code = table.concat(lines, '\n')
               bridge.send({
                 type = 'live-update',
                 fileName = vim.fn.expand('%:p'),
                 code = code,
               })
        end)
      end
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
      local buf = vim.api.nvim_get_current_buf()
      local name = vim.api.nvim_buf_get_name(buf)
      if not name:match('%.fluid%.js$') then
        return
      end
      local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
      local code = table.concat(lines, '\n')
      bridge.send({
        type = 'live-update',
        fileName = name,
        code = code,
      })
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
      local buf = vim.api.nvim_get_current_buf()
      local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
      local code = table.concat(lines, '\n')
      bridge.send({
        type = 'live-update',
        fileName = vim.api.nvim_buf_get_name(buf),
        code = code,
      })
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
