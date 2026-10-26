import React from 'react';
import { Box, Typography } from '@mui/material';
import { brand } from '../brand';

export const ACG_LOGO_SRC = '/brand/acg-logo.png';
export const ACG_LOGO_PRINT_SRC = '/brand/acg-logo-print.png';
export const AI_LOGO_SRC = '/brand/accent-imaging-logo.png';
export const AI_LOGO_PRINT_SRC = '/brand/accent-imaging-logo-print.png';
export const ACG_LOGO_ALT = 'Accent Corporate Graphics';
export const AI_LOGO_ALT = 'Accent Imaging';
export const CREDIT_SENTENCE = 'A service of Accent Imaging and Accent Corporate Graphics';

const AI_RATIO = 2056 / 1973;
const ACG_RATIO = 1796 / 1155;

export function DivisionCredit({
  height = 28,
  align = 'flex-end',
  printOnly = false,
  printSources = false,
  testId = 'division-credit',
  sx,
}) {
  const aiWidth = Math.round(height * AI_RATIO);
  const acgWidth = Math.round(height * ACG_RATIO);
  const aiSrc = printSources ? AI_LOGO_PRINT_SRC : AI_LOGO_SRC;
  const acgSrc = printSources ? ACG_LOGO_PRINT_SRC : ACG_LOGO_SRC;
  const sentenceSize = height <= 24 ? 11 : 12;

  const hiddenOnScreen = printOnly
    ? {
      display: 'none',
      '@media print': {
        display: 'flex',
        flexDirection: 'column',
        alignItems: align,
        gap: 0.4,
        maxWidth: '100%',
        ...sx,
      },
    }
    : { display: 'flex' };

  return (
    <Box
      data-testid={testId}
      sx={{
        flexDirection: 'column',
        alignItems: align,
        gap: 0.4,
        maxWidth: '100%',
        ...hiddenOnScreen,
        ...sx,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Box
          component="img"
          src={aiSrc}
          alt={AI_LOGO_ALT}
          sx={{ width: aiWidth, height, display: 'block', objectFit: 'contain' }}
        />
        <Box
          component="img"
          src={acgSrc}
          alt={ACG_LOGO_ALT}
          sx={{ width: acgWidth, height, display: 'block', objectFit: 'contain' }}
        />
      </Box>
      <Typography
        component="p"
        sx={{
          m: 0,
          fontSize: sentenceSize,
          fontWeight: 700,
          lineHeight: 1.3,
          color: brand.navy,
          textAlign: align === 'center' ? 'center' : align === 'flex-start' ? 'left' : 'right',
        }}
      >
        {CREDIT_SENTENCE}
      </Typography>
    </Box>
  );
}

export function QuotePrintCredit() {
  return (
    <DivisionCredit
      printOnly
      printSources
      height={34}
      align="flex-end"
      testId="quote-print-credit"
      sx={{
        mt: 3,
        pt: 1,
        borderTop: `2px solid ${brand.navy}`,
      }}
    />
  );
}
