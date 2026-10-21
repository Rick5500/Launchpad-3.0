import React, { useState, useSyncExternalStore } from 'react';
import { Box } from '@mui/material';

const STATIC_LOGO_SRC = '/brand/ignition-logo.png';
const STATIC_LOGO_ALT = 'Accent Ignition';

export const SIGNIN_LOGO_POSTER = '/brand/signin-logo-poster.png';
export const SIGNIN_LOGO_WEBM = '/brand/signin-logo.webm';
export const SIGNIN_LOGO_MP4 = '/brand/signin-logo.mp4';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeToReducedMotion(onChange) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function reducedMotionSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

const mediaSx = {
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
  height: 'auto',
  display: 'block',
  bgcolor: '#fff',
};

function StaticLogo({ src, alt, sx, onError }) {
  return (
    <Box
      component="img"
      src={src}
      alt={alt}
      onError={onError}
      sx={{ ...mediaSx, ...sx }}
    />
  );
}

export default function AnimatedBrandLogo({ sx }) {
  const reducedMotion = useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot, () => false);
  const [failed, setFailed] = useState(false);

  if (reducedMotion || failed) {
    const poster = reducedMotion && !failed;
    return (
      <StaticLogo
        src={poster ? SIGNIN_LOGO_POSTER : STATIC_LOGO_SRC}
        alt={poster ? 'Ignition' : STATIC_LOGO_ALT}
        sx={sx}
        onError={poster ? () => setFailed(true) : undefined}
      />
    );
  }

  return (
    <Box
      component="video"
      autoPlay
      muted
      loop
      playsInline
      poster={SIGNIN_LOGO_POSTER}
      aria-label="Ignition"
      onError={() => setFailed(true)}
      ref={(node) => {
        if (node) node.muted = true;
      }}
      sx={{ ...mediaSx, ...sx }}
    >
      <source src={SIGNIN_LOGO_WEBM} type="video/webm" />
      <source src={SIGNIN_LOGO_MP4} type="video/mp4" />
    </Box>
  );
}
