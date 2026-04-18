local M = {}

local function get_url()
  local ok, bridge = pcall(require, 'fluidcad.bridge')
  if not ok then
    return nil
  end
  return bridge.get_url()
end

--- POST a JSON body to /api/code/<endpoint> and return the decoded response,
--- or nil on any failure (server unreachable, non-2xx, decode error).
local function post(endpoint, body)
  local url = get_url()
  if not url or url == '' then
    return nil
  end
  local encoded = vim.fn.json_encode(body)
  local result = vim.fn.system(
    { 'curl', '-s', '-f', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '--data-binary', '@-',
      url .. '/api/code/' .. endpoint },
    encoded
  )
  if vim.v.shell_error ~= 0 then
    return nil
  end
  local ok, decoded = pcall(vim.fn.json_decode, result)
  if not ok or type(decoded) ~= 'table' then
    return nil
  end
  return decoded
end

function M.add_breakpoint(code, reference_row)
  return post('add-breakpoint', { code = code, referenceRow = reference_row })
end

function M.remove_breakpoint(code, line)
  return post('remove-breakpoint', { code = code, line = line })
end

function M.toggle_breakpoint(code, cursor_row)
  return post('toggle-breakpoint', { code = code, cursorRow = cursor_row })
end

function M.clear_breakpoints(code)
  return post('clear-breakpoints', { code = code })
end

function M.insert_point(code, source_line, point)
  return post('insert-point', { code = code, sourceLine = source_line, point = point })
end

function M.remove_point(code, source_line, point)
  return post('remove-point', { code = code, sourceLine = source_line, point = point })
end

function M.add_pick(code, source_line)
  return post('add-pick', { code = code, sourceLine = source_line })
end

function M.set_pick_points(code, source_line, points)
  return post('set-pick-points', { code = code, sourceLine = source_line, points = points })
end

--- Replace the entire contents of `bufnr` with `new_code`. Returns true on
--- success.
function M.replace_buffer(bufnr, new_code)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return false
  end
  local lines = vim.split(new_code, '\n', { plain = true })
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  return true
end

return M
