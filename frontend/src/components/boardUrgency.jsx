import React from 'react';
import { Box, Chip, Typography } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import FiberNewIcon from '@mui/icons-material/FiberNew';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import { brand } from '../brand';

// The board has three categories. Overdue keeps the red-orange-yellow wash.
// New is bold pale yellow. In Production has one blue tint. On hold, finished,
// and cancelled rows alternate white and pale lavender. Rush is priority data,
// not a category.
export const URGENCY_STYLES = {
  overdue: {
    label: 'Overdue',
    bgcolor: '#ff7a1a',
    background: 'linear-gradient(90deg, #ff5e54 0%, #ff7a1a 34%, #ffc14d 70%, #ffe98a 100%)',
    border: '#C62828',
    chipBg: '#F8D0D0',
    chipColor: '#7F1D1D',
    Icon: ErrorOutlineIcon,
  },
  new: {
    label: 'New',
    bgcolor: '#fff8d2',
    background: '#fff8d2',
    border: '#E6C200',
    chipBg: '#fff3b0',
    chipColor: '#6B4E00',
    Icon: FiberNewIcon,
  },
  in_production: {
    label: 'In Production',
    bgcolor: '#d6ebff',
    background: '#d6ebff',
    border: '#1565C0',
    chipBg: '#d6ebff',
    chipColor: '#0D47A1',
    Icon: BuildOutlinedIcon,
  },
};

const SIGNAL_TONE = {
  Overdue: 'overdue',
  New: 'new',
  'In Production': 'in_production',
};

const LAVENDER = '#eceaf8';

export function urgencyTone(urgency) {
  return urgency && urgency.tone ? URGENCY_STYLES[urgency.tone] : null;
}

export function rowSurface(row, index) {
  const tone = row?.urgency?.tone || row?.urgency?.category;
  if (tone === 'overdue') return { background: URGENCY_STYLES.overdue.background, bold: false };
  if (tone === 'new') return { background: URGENCY_STYLES.new.background, bold: true };
  if (tone === 'in_production') return { background: URGENCY_STYLES.in_production.background, bold: false };
  return { background: index % 2 === 0 ? '#ffffff' : LAVENDER, bold: false };
}

function chipSx(style) {
  return {
    bgcolor: style.chipBg,
    color: style.chipColor,
    fontWeight: 800,
    height: 20,
    fontSize: 11,
    '& .MuiChip-icon': { color: style.chipColor, fontSize: 14, ml: 0.4 },
    '& .MuiChip-label': { px: 0.6 },
  };
}

export function UrgencyChips({ urgency }) {
  const signals = (urgency?.signals || []).filter((signal) => SIGNAL_TONE[signal]);
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
            icon={<Icon />}
            label={signal}
            sx={chipSx(style)}
          />
        );
      })}
    </>
  );
}

function Swatch({ background, label, bold = false }) {
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        background,
        border: '1px solid rgba(27,40,56,0.12)',
        borderRadius: 0.5,
        px: 1,
        py: 0.3,
      }}
    >
      <Typography sx={{ fontSize: 12, fontWeight: bold ? 800 : 700, color: '#1B2838' }}>{label}</Typography>
    </Box>
  );
}

export function UrgencyLegend({ timezone }) {
  return (
    <Box data-testid="urgency-legend" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
      <Swatch background={URGENCY_STYLES.overdue.background} label="Overdue" />
      <Swatch background={URGENCY_STYLES.new.background} label="New" bold />
      <Swatch background={URGENCY_STYLES.in_production.background} label="In Production" />
      <Typography sx={{ fontSize: 12, color: brand.muted, flexBasis: { xs: '100%', lg: 'auto' } }}>
        Shop time{timezone ? ` (${timezone})` : ''}. On hold and finished jobs are not marked overdue.
      </Typography>
    </Box>
  );
}

function clockLabel(hour, minute, second) {
  const suffix = hour >= 12 ? 'pm' : 'am';
  const shown = hour % 12 || 12;
  const seconds = second != null ? `:${String(second).padStart(2, '0')}` : '';
  return `${shown}:${String(minute).padStart(2, '0')}${seconds} ${suffix}`;
}

export function splitWall(value, { seconds = false } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value || '').trim());
  if (!match) return { date: '', time: '' };
  const date = `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
  if (!match[4]) return { date, time: '' };
  return {
    date,
    time: clockLabel(Number(match[4]), match[5], seconds && match[6] != null ? match[6] : null),
  };
}

export function splitInstant(value, timeZone, { seconds = false } = {}) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || '').trim());
  if (!match) return { date: '', time: '' };
  const utc = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0)
  ));
  if (!timeZone || Number.isNaN(utc.valueOf())) return splitWall(value, { seconds });
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: seconds ? '2-digit' : undefined,
      hourCycle: 'h23',
    }).formatToParts(utc).map((part) => [part.type, part.value]));
    const hour = Number(parts.hour) % 24;
    return {
      date: `${Number(parts.month)}/${Number(parts.day)}/${parts.year}`,
      time: clockLabel(hour, parts.minute, seconds ? parts.second : null),
    };
  } catch (err) {
    return splitWall(value, { seconds });
  }
}
