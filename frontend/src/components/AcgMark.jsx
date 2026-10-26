import React from 'react';
import { Box, Typography } from '@mui/material';
import { brand } from '../brand';
import BrandLogo from './BrandLogo';

export const ACG_LOGO_SRC = '/brand/acg-logo.png';
export const ACG_LOGO_ALT = 'Accent Corporate Graphics';

export default function AcgMark({ sx, width = 160 }) {
  return (
    <Box
      component="img"
      src={ACG_LOGO_SRC}
      alt={ACG_LOGO_ALT}
      sx={{
        width,
        maxWidth: '100%',
        height: 'auto',
        display: 'block',
        ...sx,
      }}
    />
  );
}

export function AcgBroughtBy({ width = 148, sx, captionSx, align = 'flex-end', inline = false }) {
  return (
    <Box
      data-testid="acg-brought-by"
      sx={{
        display: 'flex',
        flexDirection: inline ? 'row' : 'column',
        alignItems: inline ? 'center' : align,
        gap: inline ? 1 : 0.5,
        ...sx,
      }}
    >
      <Typography
        component="p"
        sx={{
          m: 0,
          fontSize: 15,
          fontWeight: 700,
          lineHeight: 1.3,
          color: brand.navy,
          ...captionSx,
        }}
      >
        Brought to you by
      </Typography>
      <AcgMark width={width} />
    </Box>
  );
}

export function QuotePrintMasthead({ kicker = 'Quote' }) {
  return (
    <Box
      data-testid="quote-print-header"
      sx={{
        display: 'none',
        '@media print': {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 2,
          mb: 2,
          px: 2,
          py: 1.25,
          bgcolor: brand.navy,
          borderBottom: `4px solid ${brand.orange}`,
          borderRadius: 1,
          WebkitPrintColorAdjust: 'exact',
          printColorAdjust: 'exact',
        },
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <BrandLogo sx={{ width: 240 }} />
        <Typography sx={{ color: '#fff', fontWeight: 800, fontSize: 26, lineHeight: 1.15, mt: 0.5 }}>
          {kicker}
        </Typography>
      </Box>
      <Box sx={{ bgcolor: '#fff', borderRadius: 1, px: 1, py: 0.75, flex: '0 0 auto' }}>
        <AcgBroughtBy width={136} captionSx={{ fontSize: 14 }} />
      </Box>
    </Box>
  );
}
