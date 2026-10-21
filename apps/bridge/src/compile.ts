/**
 * Compiling a sketch with the local arduino-cli: the implementation moved to scripts/compile.ts
 * (BT70), which the CLI's MCP server shares; the bridge's modules import it from here.
 */

export { arduinoCliCandidates, buildPathFor, COMPILE_TIMEOUT_MS, type CompileArtifacts, type CompileResult, compile, compileInlineSketch, findArduinoCli } from '../../../scripts/compile.ts';
