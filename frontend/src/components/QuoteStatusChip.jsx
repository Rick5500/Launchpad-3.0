import React from 'react';
import { Chip } from '@mui/material';
import { brand } from '../brand';

const COLORS = {
  New: { bgcolor: brand.orange, color: '#111' },
  Quoted: { bgcolor: '#E8EEF8', color: brand.navy },
  Accepted: { bgcolor: '#E5F6EA', color: brand.greenDark },
  Declined: { bgcolor: '#FDECEC', color: brand.danger },
};

export default function QuoteStatusChip({ status }) {
  const colors = COLORS[status] || { bgcolor: '#EEF2F6', color: brand.text };
  return (
    <Chip
      label={status || 'Quote'}
      sx={{
        fontWeight: 800,
        fontSize: '1.05rem',
        height: 36,
        ...colors,
      }}
    />
  );
}
