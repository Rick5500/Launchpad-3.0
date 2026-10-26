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

const stackSx = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-start',
  gap: 1,
  width: '100%',
  maxWidth: '100%',
  boxSizing: 'border-box',
};

export function DivisionCredit({
  height = 28,
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
        ...stackSx,
        ...sx,
      },
    }
    : null;

  return (
    <Box
      data-testid={testId}
      sx={{
        ...stackSx,
        ...hiddenOnScreen,
        ...sx,
      }}
    >
      <Box
        data-testid={`${testId}-logos`}
        sx={{
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'nowrap',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          flexShrink: 0,
        }}
      >
        <Box
          component="img"
          src={aiSrc}
          alt={AI_LOGO_ALT}
          sx={{ width: aiWidth, height, flexShrink: 0, display: 'block', objectFit: 'contain' }}
        />
        <Box
          component="img"
          src={acgSrc}
          alt={ACG_LOGO_ALT}
          sx={{ width: acgWidth, height, flexShrink: 0, display: 'block', objectFit: 'contain' }}
        />
      </Box>
      <Typography
        component="p"
        data-testid={`${testId}-text`}
        sx={{
          m: 0,
          width: '100%',
          maxWidth: '100%',
          fontSize: sentenceSize,
          fontWeight: 700,
          lineHeight: 1.35,
          color: brand.navy,
          textAlign: 'center',
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
      testId="quote-print-credit"
      sx={{
        mt: 3,
        pt: 1,
        borderTop: `2px solid ${brand.navy}`,
      }}
    />
  );
}
