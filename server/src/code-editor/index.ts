// Public surface of the code-editor toolkit: tree-sitter backed edits of .fluid.js source.
// Every consumer imports from here; the modules behind it are grouped by concern.

export { getJavaScriptParser, type TSNode, type TSTree } from './parser.ts';
export { isExpressionText } from './expression-text.ts';
export {
  RenderedProperties,
  type PropertySourceCall,
  type PropertySourceKind,
  type RenderedInstanceProperties,
  type RenderedPartProperties,
  type RenderedPropertySources,
  type RenderedPropertyValue,
} from './rendered-properties.ts';
export { LexicalBindings, type Binding, type BindingKind, type ValueKind } from './lexical-bindings.ts';
export {
  indentOf,
  isBlankRow,
  joinLines,
  quoteForSingleQuotes,
  spliceCode,
  splitLines,
  type CodeEditResult,
} from './lines.ts';
export {
  chainRootCallee,
  collectBoundNames,
  enclosingStatementOf,
  findEditableCallAt,
  stringLiteralValue,
  walkTree,
} from './nodes.ts';
export { addGuide, getPointExpression, insertPoint, removeGuide, removePoint } from './points.ts';
export {
  addBreakpoint,
  clearBreakpoints,
  isBreakpointStatement,
  removeBreakpoint,
  toggleBreakpoint,
  type BreakpointEditResult,
} from './breakpoints.ts';
export {
  clearDocumentUnit,
  findTopLevelUnitStatement,
  isUnitStatement,
  readUnitStatement,
  setDocumentUnit,
  unitStatementLiteral,
  type SetUnitResult,
  type UnitStatement,
} from './units.ts';
export { ensureSymbolImport, importLocalName, removeSymbolImport } from './imports.ts';
export {
  findSketchBody,
  insertGeometryCall,
  insertLoadCall,
  isDerivedOpStatement,
  isRegionDeclarationStatement,
  isSolvedConstraintStatement,
  isSolvedSketchCall,
  removeStatement,
  removeStatementNode,
  setFeatureName,
  setPartMaterial,
  setSketchClosed,
} from './statements.ts';
export {
  updateSketchPositions,
  type SketchPositionEdit,
  type SketchPositionPointEdit,
  type SketchPositionsResult,
} from './sketch-positions.ts';
export { getDimensionExpression, updateDimension, updateDimensionExpression } from './dimensions.ts';
export { declareTopLevelVariable, findTopLevelDeclarationAnchor } from './declarations.ts';
export {
  declareInPartBody,
  declareParamStatements,
  declareParamStatementsFor,
  findEnclosingPart,
  findPartAt,
  type PartBody,
} from './parts.ts';
export {
  declareSketchVariable,
  extractVariablesInPart,
  extractVariablesInAssembly,
  extractVariablesInScope,
  insertGeometryCallWithVariable,
  updateDimensionExpressionWithVariable,
  type NewVariableDecl,
  type VariableInfo,
} from './variables.ts';
