import React from 'react';
import { Box } from '@mui/material';

export const LAUNCHPAD_LOGO_SRC = '/brand/logo.png';
export const LAUNCHPAD_LOGO_ALT = 'Launchpad';

export default function BrandLogo({ sx }) {
  return (
    <Box
      component="img"
      src={LAUNCHPAD_LOGO_SRC}
      alt={LAUNCHPAD_LOGO_ALT}
      sx={{
        width: '100%',
        maxWidth: '100%',
        height: 'auto',
        display: 'block',
        ...sx,
      }}
    />
  );
}
