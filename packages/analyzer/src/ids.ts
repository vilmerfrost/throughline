// Legacy scaffold ids kept only for the bundled offline sample graph.
// Real analyzer implementations generate ids from parsed source locations.
export const NODE_IDS = {
  contractBatches: 'contract:batches',
  tsBatchData: 'touch:ts:batchData',
  rustBatchesWriter: 'touch:rust:batches-writer',
} as const;
