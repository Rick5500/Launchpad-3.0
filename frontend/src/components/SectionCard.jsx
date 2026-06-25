import React from 'react';
import { Card, CardContent, Typography } from '@mui/material';

export default function SectionCard({ title, subtitle, children }) {
  return (
    <Card sx={{ mb: 3, bgcolor: '#1f2a38' }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary" gutterBottom>
            {subtitle}
          </Typography>
        )}
        {children}
      </CardContent>
    </Card>
  );
}
