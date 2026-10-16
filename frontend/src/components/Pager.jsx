import React from 'react';
import { Box, Button, Typography } from '@mui/material';

export default function Pager({ offset, limit, total, onChange }) {
  if (!total || total <= limit) return null;
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1, gap: 1 }}>
      <Button disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Previous
      </Button>
      <Typography color="text.secondary" sx={{ fontSize: 14 }}>
        {start}–{end} of {total}
      </Typography>
      <Button disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
        Next
      </Button>
    </Box>
  );
}
