local M = {}

local SIGN_NAME = 'FluidCadBreakpoint'
local SIGN_GROUP = 'fluidcad-breakpoints'
local BREAKPOINT_PATTERN = '^%s*breakpoint%s*%(%s*%)%s*;?%s*$'
local IMPORT_PATTERN = "import%s*{([^}]*)}%s*from%s*['\"]fluidcad[^'\"]*['\"]"

local defined = false

local function ensure_sign_defined()
  if defined then
    return
  end
  vim.fn.sign_define(SIGN_NAME, { text = '●', texthl = 'ErrorMsg' })
  defined = true
end

local function ensure_import(bufnr)
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  for i, line in ipairs(lines) do
    local names = line:match(IMPORT_PATTERN)
    if names then
      if names:match('%f[%w]breakpoint%f[%W]') then
        return 0
      end
      local replaced, count = line:gsub('(import%s*{)', '%1 breakpoint,', 1)
      if count > 0 then
        vim.api.nvim_buf_set_lines(bufnr, i - 1, i, false, { replaced })
      end
      return 0
    end
  end
  vim.api.nvim_buf_set_lines(bufnr, 0, 0, false, { "import { breakpoint } from 'fluidcad/core';" })
  return 1
end

--- Insert `breakpoint();` at 0-indexed `target_row` with the given indent,
--- ensuring at least one blank line follows it. Caller must have already
--- added the import (via ensure_import) if applicable.
local function insert_breakpoint_line(bufnr, target_row, indent)
  local line_count = vim.api.nvim_buf_line_count(bufnr)
  if target_row >= line_count then
    -- Append at end of buffer
    vim.api.nvim_buf_set_lines(bufnr, line_count, line_count, false, { indent .. 'breakpoint();', '' })
    return
  end
  local following = vim.api.nvim_buf_get_lines(bufnr, target_row, target_row + 1, false)[1] or ''
  local to_insert = { indent .. 'breakpoint();' }
  if following:match('%S') then
    table.insert(to_insert, '')
  end
  vim.api.nvim_buf_set_lines(bufnr, target_row, target_row, false, to_insert)
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

local function send_live_update(bufnr)
  local ok, bridge = pcall(require, 'fluidcad.bridge')
  if not ok then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  bridge.send({
    type = 'live-update',
    fileName = vim.api.nvim_buf_get_name(bufnr),
    code = table.concat(lines, '\n'),
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

  local lnum = vim.api.nvim_win_get_cursor(0)[1]
  local current = vim.api.nvim_buf_get_lines(bufnr, lnum - 1, lnum, false)[1] or ''
  local next_line = vim.api.nvim_buf_get_lines(bufnr, lnum, lnum + 1, false)[1]

  if current:match(BREAKPOINT_PATTERN) then
    vim.api.nvim_buf_set_lines(bufnr, lnum - 1, lnum, false, {})
  elseif next_line and next_line:match(BREAKPOINT_PATTERN) then
    vim.api.nvim_buf_set_lines(bufnr, lnum, lnum + 1, false, {})
  else
    local indent = current:match('^(%s*)') or ''
    ensure_import(bufnr)
    -- Cursor tracks line inserts above it, so re-read its position.
    local new_lnum = vim.api.nvim_win_get_cursor(0)[1]
    insert_breakpoint_line(bufnr, new_lnum, indent)
  end

  M.refresh(bufnr)
end

--- Remove every `breakpoint();` line from the buffer matching `file_path`.
--- Refreshes the sign column and explicitly sends a live-update since
--- `TextChanged` does not fire for programmatic edits on non-current buffers.
function M.clear_all(file_path)
  local bufnr = find_buffer_for_path(file_path) or vim.api.nvim_get_current_buf()
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end
  local name = vim.api.nvim_buf_get_name(bufnr)
  if not name:match('%.fluid%.js$') then
    return
  end

  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local removed = false
  -- Walk bottom-up so row indices remain valid as we delete.
  for i = #lines, 1, -1 do
    if lines[i]:match(BREAKPOINT_PATTERN) then
      vim.api.nvim_buf_set_lines(bufnr, i - 1, i, false, {})
      removed = true
    end
  end
  if not removed then
    return
  end

  M.refresh(bufnr)
  send_live_update(bufnr)
end

--- Insert a breakpoint() call on the line immediately after the given
--- 1-indexed `src_line`, for the buffer matching `file_path`.
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

  -- Convert to 0-indexed and walk back over trailing blanks.
  local source_row = math.min(src_line - 1, line_count - 1)
  while source_row >= 0 do
    local text = vim.api.nvim_buf_get_lines(bufnr, source_row, source_row + 1, false)[1] or ''
    if text:match('%S') then
      break
    end
    source_row = source_row - 1
  end
  if source_row < 0 then
    return
  end

  local target = source_row + 1
  local following = vim.api.nvim_buf_get_lines(bufnr, target, target + 1, false)[1]
  if following and following:match(BREAKPOINT_PATTERN) then
    return
  end

  local source_text = vim.api.nvim_buf_get_lines(bufnr, source_row, source_row + 1, false)[1] or ''
  local indent = source_text:match('^(%s*)') or ''

  local shifted = ensure_import(bufnr)
  insert_breakpoint_line(bufnr, target + shifted, indent)

  M.refresh(bufnr)
  send_live_update(bufnr)
end

return M
