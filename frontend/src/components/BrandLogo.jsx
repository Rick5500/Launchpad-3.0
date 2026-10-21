import React from 'react';
import { Box } from '@mui/material';
import AnimatedBrandLogo from './AnimatedBrandLogo';

export const IGNITION_LOGO_SRC = '/brand/ignition-logo.png';
export const IGNITION_LOGO_ALT = 'Accent Ignition';

export default function BrandLogo({ onNavy = false, sx, imgSx, animated = false }) {
  return (
    <Box
      sx={{
        display: 'block',
        lineHeight: 0,
        maxWidth: '100%',
        ...(onNavy
          ? {
              bgcolor: '#fff',
              borderRadius: '16px',
              px: 1.25,
              py: 0.75,
            }
          : null),
        ...sx,
      }}
    >
      {animated ? (
        <AnimatedBrandLogo sx={imgSx} />
      ) : (
        <Box
          component="img"
          src={IGNITION_LOGO_SRC}
          alt={IGNITION_LOGO_ALT}
          sx={{ width: '100%', maxWidth: '100%', height: 'auto', display: 'block', ...imgSx }}
        />
      )}
    </Box>
  );
}
