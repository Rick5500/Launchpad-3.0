import React from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';

export default function LoadingState({ message = 'Loading...' }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 6 }}>
      <CircularProgress color="primary" />
      <Typography sx={{ mt: 2 }} color="text.secondary">
        {message}
      </Typography>
    </Box>
  );
}
