--- Mirror of the server's file-kind suffixes (extension/vscode/src/file-kind.ts):
--- part, assembly, and legacy .fluid.js sources are all fluid scripts. Every
--- suffix gate in the plugin goes through this module — per-site copies are
--- how .part.js buffers ended up silently refused by the breakpoint paths.
local M = {}

--- Autocmd glob patterns covering every fluid-script suffix.
M.patterns = { '*.part.js', '*.assembly.js', '*.fluid.js' }

function M.is_fluid_script(name)
  return name:match('%.part%.js$') ~= nil
    or name:match('%.assembly%.js$') ~= nil
    or name:match('%.fluid%.js$') ~= nil
end

return M
