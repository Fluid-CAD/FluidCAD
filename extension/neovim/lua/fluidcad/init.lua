local bridge = require('fluidcad.bridge')
local commands = require('fluidcad.commands')
local autocmds = require('fluidcad.autocmds')

local M = {}

M.config = {
  bridge_path = nil, -- auto-detected
  auto_start = true,
  open_browser = true,
  debounce_ms = 300,
}

function M.setup(opts)
  opts = opts or {}
  M.config = vim.tbl_deep_extend('force', M.config, opts)

  -- Auto-detect bridge.cjs relative to this plugin's install path
  if not M.config.bridge_path then
    local source = debug.getinfo(1, 'S').source:sub(2) -- remove leading @
    local plugin_root = vim.fn.fnamemodify(source, ':h:h:h') -- lua/fluidcad/init.lua → plugin root
    M.config.bridge_path = plugin_root .. '/bridge.cjs'
  end

  bridge.setup(M.config)
  commands.setup(M.config)
  autocmds.setup(M.config)
end

return M
