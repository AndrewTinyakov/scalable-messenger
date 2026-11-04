const failureCounts = new Set(['saved.missingNotification', 'saved.missingAccepted', 'operation.rejected', 'transport.decode', 'transport.error', 'transport.unexpectedClose', 'driver.fatal', 'send.dropped', 'send.driverDropped', 'send.lateDropped', 'read.pendingAtEnd']);

export function assess(counts) {
  const offeredDispatchedMismatch = Math.abs((counts['send.offered'] ?? 0) - (counts['send.dispatched'] ?? 0));
  const failures = Object.entries(counts).reduce((sum, [key, count]) => sum + (failureCounts.has(key) || key.endsWith('.failed') || key.endsWith('.taskFailed') ? count : 0), offeredDispatchedMismatch);
  return { passed: failures === 0, failures, offeredDispatchedMismatch };
}
