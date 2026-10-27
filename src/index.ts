/**
 * Public surface of the bot core: the SPEC-001 contract types. Runtime code
 * arrives with PLAN-001 Phase 1; the Electron shell and any other host only
 * ever depend on what is exported from here.
 */
export type * from './core/types.ts';
