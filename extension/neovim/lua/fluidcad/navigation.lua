local M = {}

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

local function find_window_for_buf(bufnr)
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(w) == bufnr then
      return w
    end
  end
  return nil
end

--- Move the cursor to (line, column) in the buffer for `file_path`.
--- line is 1-indexed, column is 0-indexed.
function M.goto_source(file_path, line, column)
  local bufnr = find_buffer_for_path(file_path)
  if not bufnr then
    vim.cmd('edit ' .. vim.fn.fnameescape(file_path))
    bufnr = vim.api.nvim_get_current_buf()
  end
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return
  end

  local line_count = vim.api.nvim_buf_line_count(bufnr)
  if line_count == 0 then
    return
  end
  local target_line = math.max(math.min(line, line_count), 1)
  local line_text = vim.api.nvim_buf_get_lines(bufnr, target_line - 1, target_line, false)[1] or ''
  local target_col = math.max(math.min(column, #line_text), 0)

  local win = find_window_for_buf(bufnr)
  if win then
    vim.api.nvim_win_set_cursor(win, { target_line, target_col })
  else
    vim.api.nvim_set_current_buf(bufnr)
    vim.api.nvim_win_set_cursor(0, { target_line, target_col })
  end
end

return M
