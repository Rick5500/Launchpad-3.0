import React, { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Tabs,
  Tab,
  Alert,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { authFetch } from '../api';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';

export default function Delivery() {
  const navigate = useNavigate();
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('both');
  const [completionDialogOpen, setCompletionDialogOpen] = useState(false);
  const [selectedDelivery, setSelectedDelivery] = useState(null);
  const [markingComplete, setMarkingComplete] = useState(false);

  const loadDeliveries = () => {
    setLoading(true);
    const url = filter === 'both' 
      ? '/api/delivery/upcoming' 
      : `/api/delivery/upcoming?type=${filter}`;
    
    authFetch(url)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load deliveries');
        return res.json();
      })
      .then(data => {
        setDeliveries(data || []);
        setError('');
      })
      .catch(err => {
        setError(err.message || 'Failed to load deliveries');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadDeliveries();
  }, [filter]);

  const formatDateTime = (dateString) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleRowClick = (deliveryId) => {
    if (deliveries.find(d => d.id === deliveryId)) {
      navigate(`/workorders/${deliveries.find(d => d.id === deliveryId).id}`);
    }
  };

  const handleMarkCompleteClick = (e, delivery) => {
    e.stopPropagation();
    setSelectedDelivery(delivery);
    setCompletionDialogOpen(true);
  };

  const handleConfirmCompletion = async () => {
    if (!selectedDelivery) return;

    setMarkingComplete(true);
    try {
      const response = await authFetch(`/api/matrix/work-orders/${selectedDelivery.id}/delivery-complete`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const errorData = await response.json();
        setError(errorData.error || 'Failed to mark delivery complete');
        setCompletionDialogOpen(false);
        return;
      }

      setCompletionDialogOpen(false);
      setSelectedDelivery(null);
      loadDeliveries();
    } catch (err) {
      setError(err.message || 'Failed to mark delivery complete');
      setCompletionDialogOpen(false);
    } finally {
      setMarkingComplete(false);
    }
  };

  const handleCancelCompletion = () => {
    setCompletionDialogOpen(false);
    setSelectedDelivery(null);
    setMarkingComplete(false);
  };

  if (loading) {
    return <LoadingState message="Loading delivery queue..." />;
  }

  return (
    <Box sx={{ p: 2 }}>
      <Card>
        <CardHeader
          title="Delivery & Will Call Queue"
          subheader="Upcoming delivery and will-call requests"
        />
        <CardContent>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          <Tabs value={filter} onChange={(e, newFilter) => setFilter(newFilter)} sx={{ mb: 2 }}>
            <Tab label="All" value="both" />
            <Tab label="Delivery" value="delivery" />
            <Tab label="Will Call" value="will_call" />
          </Tabs>

          {deliveries.length === 0 ? (
            <Alert severity="info">No deliveries scheduled</Alert>
          ) : (
            <TableContainer component={Paper} sx={{ overflowX: 'auto', backgroundColor: '#0f1822' }}>
              <Table stickyHeader size="small" sx={{ backgroundColor: '#0f1822' }}>
                <TableHead>
                  <TableRow sx={{ backgroundColor: '#1f2a38' }}>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px', color: '#ccc', backgroundColor: '#1f2a38' }}>Work Order</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '150px', color: '#ccc', backgroundColor: '#1f2a38' }}>Customer</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '140px', color: '#ccc', backgroundColor: '#1f2a38' }}>Description</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '140px', color: '#ccc', backgroundColor: '#1f2a38' }}>Delivery Date & Time</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '120px', color: '#ccc', backgroundColor: '#1f2a38' }}>Requested Date & Time</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px', color: '#ccc', backgroundColor: '#1f2a38' }}>Type</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px', color: '#ccc', backgroundColor: '#1f2a38' }}>Status</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '120px', color: '#ccc', backgroundColor: '#1f2a38' }}>Action</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {deliveries.map((delivery) => (
                    <TableRow
                      key={delivery.id}
                      onClick={() => navigate(`/workorders/${delivery.id}`)}
                      sx={{
                        cursor: 'pointer',
                        backgroundColor: '#1f2a38',
                        borderLeft: '4px solid #2196f3',
                        '&:hover': { backgroundColor: '#334455' },
                      }}
                    >
                      <TableCell sx={{ fontWeight: 500, color: '#eee' }}>
                        {delivery.external_id || `#${delivery.id}`}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc' }}>
                        {delivery.customer_name || '—'}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc' }}>
                        {delivery.description || '—'}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc' }}>
                        {formatDateTime(delivery.due_date)}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc' }}>
                        {formatDateTime(delivery.requested_delivery_time)}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc', fontWeight: 'bold' }}>
                        {delivery.delivery_method === 'will_call' ? 'WILL CALL' : 'DELIVERY'}
                      </TableCell>
                      <TableCell>
                        {delivery.delivery_status === 'Ready' ? (
                          <Box
                            sx={{
                              backgroundColor: '#2196F3',
                              color: '#fff',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '0.75rem',
                              fontWeight: 'bold',
                              textAlign: 'center',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            Ready
                          </Box>
                        ) : delivery.delivery_status === 'Complete' ? (
                          <Box
                            sx={{
                              backgroundColor: '#66BB6A',
                              color: '#fff',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '0.75rem',
                              fontWeight: 'bold',
                              textAlign: 'center',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            ✓ Complete
                          </Box>
                        ) : (
                          <Box
                            sx={{
                              backgroundColor: '#BDBDBD',
                              color: '#757575',
                              padding: '4px 8px',
                              borderRadius: '4px',
                              fontSize: '0.75rem',
                              fontWeight: 'bold',
                              textAlign: 'center',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            Pending
                          </Box>
                        )}
                      </TableCell>
                      <TableCell>
                        {delivery.delivery_status === 'Ready' ? (
                          <Button
                            size="small"
                            variant="contained"
                            color="success"
                            onClick={(e) => handleMarkCompleteClick(e, delivery)}
                          >
                            Complete
                          </Button>
                        ) : delivery.delivery_status === 'Complete' ? (
                          <Box sx={{ color: '#66BB6A', fontSize: '0.875rem', fontWeight: 'bold' }}>
                            Done
                          </Box>
                        ) : (
                          <Box sx={{ color: '#999', fontSize: '0.875rem' }}>
                            Pending QC
                          </Box>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={completionDialogOpen}
        onClose={handleCancelCompletion}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 'bold' }}>
          Complete Delivery
        </DialogTitle>
        <DialogContent sx={{ mt: 2 }}>
          {selectedDelivery && (
            <Box>
              <Box sx={{ mb: 2 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <span style={{ fontWeight: 'bold' }}>Work Order:</span>
                  <span>#{selectedDelivery.external_id || selectedDelivery.id}</span>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                  <span style={{ fontWeight: 'bold' }}>Customer:</span>
                  <span>{selectedDelivery.customer_name || '—'}</span>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 'bold' }}>Type:</span>
                  <span>
                    {selectedDelivery.delivery_method === 'will_call' ? 'Will Call' : 'Delivery'}
                  </span>
                </Box>
              </Box>
              <Box sx={{ p: 1.5, backgroundColor: '#f5f5f5', borderRadius: 1, color: '#333' }}>
                Mark this {selectedDelivery.delivery_method === 'will_call' ? 'will call' : 'delivery'} as complete? 
                This will finalize the work order and move it to the Completed section.
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button
            onClick={handleCancelCompletion}
            disabled={markingComplete}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirmCompletion}
            variant="contained"
            color="success"
            disabled={markingComplete}
          >
            {markingComplete ? 'Completing...' : 'Mark Complete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
