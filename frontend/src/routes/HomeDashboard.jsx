import React from 'react';
import { Grid, Box, Typography, Card, CardActionArea, CardContent } from '@mui/material';
import { useNavigate } from 'react-router-dom';

const cards = [
  { title: 'Work Orders', route: '/work-orders' },
  { title: 'Production Board', route: '/production-board' },
  { title: 'Customers', route: '/customers' },
  { title: 'Delivery', route: '/delivery' },
  { title: 'Reports', route: '/reports' },
  { title: 'Admin', route: '/admin' },
];

export default function HomeDashboard() {
  const navigate = useNavigate();

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Launchpad 3.0 Dashboard
      </Typography>
      <Typography variant="body1" color="text.secondary" gutterBottom>
        Access key modules for work order management, production tracking, customer operations, delivery planning, reporting, and administration.
      </Typography>
      <Grid container spacing={3} sx={{ mt: 1 }}>
        {cards.map((card) => (
          <Grid key={card.title} xs={12} sm={6} md={4}>
            <Card sx={{ minHeight: 150, display: 'flex', flexDirection: 'column' }}>
              <CardActionArea sx={{ flexGrow: 1 }} onClick={() => navigate(card.route)}>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    {card.title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {`Open the ${card.title} module and explore the feature.`}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
