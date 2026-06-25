import React from 'react';
import { Box, Typography } from '@mui/material';

export default function PlaceholderPage({ title }) {
  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        {title}
      </Typography>
      <Typography color="text.secondary">
        This is a placeholder route for the {title} module. The page is ready to receive feature development.
      </Typography>
    </Box>
  );
}
