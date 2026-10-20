import React from 'react';
import { Chip } from '@mui/material';

export const PROOF_STATUS_LABELS = {
  awaiting: 'Awaiting proof approval',
  changes_requested: 'Changes requested',
  approved: 'Approved',
};

export function proofStatusLabel(status, label) {
  if (label) return label;
  return PROOF_STATUS_LABELS[status] || '';
}

export function proofChipSx(status) {
  if (status === 'approved') return { bgcolor: '#E7F6EC', color: '#237A3D', fontWeight: 700 };
  if (status === 'changes_requested') return { bgcolor: '#FFF4E5', color: '#9A3412', fontWeight: 700 };
  return { bgcolor: '#0A2F6E', color: '#fff', fontWeight: 700 };
}

export function isProofHeld(status) {
  return status === 'awaiting' || status === 'changes_requested';
}

export default function ProofStatusChip({ status, label, testId = 'proof-status-chip' }) {
  const text = proofStatusLabel(status, label);
  if (!status || !text) return null;
  return (
    <Chip
      size="small"
      label={text}
      data-testid={testId}
      sx={proofChipSx(status)}
    />
  );
}
