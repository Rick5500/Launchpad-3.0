import React from 'react';
import { Card, CardContent, Typography } from '@mui/material';

export default function SectionCard({ title, subtitle, children }) {
  return (
    <Card sx={{ mb: 3, bgcolor: '#ffffff', border: '1px solid #e2e8f0' }}>
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
