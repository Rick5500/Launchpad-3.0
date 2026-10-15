import React from 'react';
import { Box, Typography } from '@mui/material';
import { brand } from '../brand';

export default function PlaceholderPage({ title, detail }) {
  return (
    <Box sx={{ p: { xs: 1, md: 2 }, bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 2 }}>
      <Typography variant="h5" sx={{ color: brand.navy, fontWeight: 700 }} gutterBottom>
        {title}
      </Typography>
      <Typography color="text.secondary">
        {detail || 'Coming in the next phase.'}
      </Typography>
    </Box>
  );
}
