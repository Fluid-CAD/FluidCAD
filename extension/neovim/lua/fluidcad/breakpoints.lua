local M = {}

local code_api = require('fluidcad.code_api')

local SIGN_NAME = 'FluidCadBreakpoint'
local SIGN_GROUP = 'fluidcad-breakpoints'
local BREAKPOINT_PATTERN = '^%s*breakpoint%s*%(%s*%)%s*;?%s*$'

local defined = false

local function ensure_sign_defined()
  if defined then
    return
  end
  vim.fn.sign_define(SIGN_NAME, { text = '●', texthl = 'ErrorMsg' })
  defined = true
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

local function buffer_text(bufnr)
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  return table.concat(lines, '\n')
end

local function send_live_update(bufnr)
  local ok, bridge = pcall(require, 'fluidcad.bridge')
  if not ok then
    return
  end
  bridge.send({
    type = 'live-update',
    fileName = vim.api.nvim_buf_get_name(bufnr),
    code = buffer_text(bufnr),
  })
end

function M.refresh(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local name = vim.api.nvim_buf_get_name(bufnr)
  if not name:match('%.fluid%.js$') then
    return
  end
  ensure_sign_defined()
  vim.fn.sign_unplace(SIGN_GROUP, { buffer = bufnr })

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  for i, line in ipairs(lines) do
    if line:match(BREAKPOINT_PATTERN) then
      vim.fn.sign_place(0, SIGN_GROUP, SIGN_NAME, bufnr, { lnum = i })
    end
  end
end

function M.toggle()
  local bufnr = vim.api.nvim_get_current_buf()
  local name = vim.api.nvim_buf_get_name(bufnr)
  if not name:match('%.fluid%.js$') then
    vim.notify('[fluidcad] Not a .fluid.js buffer', vim.log.levels.WARN)
    return
  end

  local cursor_row = vim.api.nvim_win_get_cursor(0)[1] - 1
  local result = code_api.toggle_breakpoint(buffer_text(bufnr), cursor_row)
  if not result or type(result.newCode) ~= 'string' then
    return
  end
  code_api.replace_buffer(bufnr, result.newCode)
  M.refresh(bufnr)
end

--- Remove every `breakpoint();` line from the buffer matching `file_path`.
function M.clear_all(file_path)
  local bufnr = find_buffer_for_path(file_path) or vim.api.nvim_get_current_buf()
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local name = vim.api.nvim_buf_get_name(bufnr)
  if not name:match('%.fluid%.js$') then
    return
  end

  local result = code_api.clear_breakpoints(buffer_text(bufnr))
  if not result or type(result.newCode) ~= 'string' then
    return
  end
  code_api.replace_buffer(bufnr, result.newCode)
  M.refresh(bufnr)
  send_live_update(bufnr)
end

--- Insert a breakpoint() call after the given 1-indexed `src_line` in the
--- buffer matching `file_path`.
function M.add_after(file_path, src_line)
  local bufnr = find_buffer_for_path(file_path) or vim.api.nvim_get_current_buf()
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local name = vim.api.nvim_buf_get_name(bufnr)
  if not name:match('%.fluid%.js$') then
    return
  end

  local line_count = vim.api.nvim_buf_line_count(bufnr)
  if line_count == 0 then
    return
  end

  local reference_row = math.max(math.min(src_line - 1, line_count - 1), 0)
  local result = code_api.add_breakpoint(buffer_text(bufnr), reference_row)
  if not result or type(result.newCode) ~= 'string' then
    return
  end
  code_api.replace_buffer(bufnr, result.newCode)
  M.refresh(bufnr)
  send_live_update(bufnr)
end

return M
