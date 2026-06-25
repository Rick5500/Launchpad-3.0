import React from 'react';
import { Box, Typography } from '@mui/material';

export default function ErrorState({ message = 'Something went wrong.' }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 6 }}>
      <Typography variant="h6" color="error.main">
        Error
      </Typography>
      <Typography sx={{ mt: 1 }} color="text.secondary">
        {message}
      </Typography>
    </Box>
  );
}
