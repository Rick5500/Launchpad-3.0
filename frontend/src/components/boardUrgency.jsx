import React from 'react';
import { Box, Chip, Typography } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import ScheduleIcon from '@mui/icons-material/Schedule';
import TodayIcon from '@mui/icons-material/Today';
import BoltIcon from '@mui/icons-material/Bolt';
import { brand } from '../brand';

// Colours are a 3.0 choice. No Launch Pad 2.0 swatch was in the repo.
// Text and an icon travel with every colour.
export const URGENCY_STYLES = {
  overdue: {
    label: 'Overdue',
    bgcolor: '#FDECEC',
    border: '#C62828',
    chipBg: '#F8D0D0',
    chipColor: '#7F1D1D',
    Icon: ErrorOutlineIcon,
  },
  due_soon: {
    label: 'Due soon',
    bgcolor: '#FFF1E4',
    border: '#C2410C',
    chipBg: '#FDE0C4',
    chipColor: '#7C2D12',
    Icon: ScheduleIcon,
  },
  due_today: {
    label: 'Due today',
    bgcolor: '#FFF8E1',
    border: '#B8860B',
    chipBg: '#FDE9A8',
    chipColor: '#6B4E00',
    Icon: TodayIcon,
  },
  rush: {
    label: 'Rush',
    bgcolor: '#EEF3FA',
    border: brand.navy,
    chipBg: brand.orange,
    chipColor: '#1B2838',
    Icon: BoltIcon,
  },
};

const SIGNAL_TONE = {
  Overdue: 'overdue',
  'Due soon': 'due_soon',
  'Due today': 'due_today',
  Rush: 'rush',
};

export function urgencyTone(urgency) {
  return urgency && urgency.tone ? URGENCY_STYLES[urgency.tone] : null;
}

export function UrgencyChips({ urgency }) {
  const signals = urgency?.signals || [];
  if (!signals.length) return null;
  return (
    <>
      {signals.map((signal) => {
        const style = URGENCY_STYLES[SIGNAL_TONE[signal]];
        if (!style) return null;
        const Icon = style.Icon;
        return (
          <Chip
            key={signal}
            size="small"
            icon={<Icon sx={{ fontSize: 16 }} />}
            label={signal}
            sx={{
              bgcolor: style.chipBg,
              color: style.chipColor,
              fontWeight: 800,
              height: 24,
              '& .MuiChip-icon': { color: style.chipColor },
            }}
          />
        );
      })}
    </>
  );
}

export function UrgencyLegend({ timezone }) {
  const items = ['overdue', 'due_today', 'due_soon', 'rush'];
  return (
    <Box data-testid="urgency-legend" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
      {items.map((key) => {
        const style = URGENCY_STYLES[key];
        const Icon = style.Icon;
        return (
          <Box
            key={key}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.5,
              bgcolor: style.bgcolor,
              borderLeft: `4px solid ${style.border}`,
              borderRadius: 1,
              px: 1,
              py: 0.4,
            }}
          >
            <Icon sx={{ fontSize: 16, color: style.chipColor }} />
            <Typography sx={{ fontSize: 13, fontWeight: 800, color: style.chipColor }}>{style.label}</Typography>
          </Box>
        );
      })}
      <Typography sx={{ fontSize: 12, color: brand.muted, flexBasis: { xs: '100%', md: 'auto' } }}>
        Shop time{timezone ? ` (${timezone})` : ''}. A job can be Rush and overdue at the same time. On hold and completed jobs are not marked overdue.
      </Typography>
    </Box>
  );
}
