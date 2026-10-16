import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { authFetch } from '../api';
import { formatClockLabel, formatFileSize } from '../brand';
import ErrorState from '../components/ErrorState';
import LoadingState from '../components/LoadingState';
import './workOrderPrint.css';

function formatStamp(value) {
  if (!value) return '';
  const text = String(value).trim().replace('T', ' ');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(text);
  if (!match) return text;
  const date = `${match[2]}/${match[3]}/${match[1]}`;
  if (match[4] == null) return date;
  const hour = Number(match[4]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${date} ${hour12}:${match[5]} ${suffix}`;
}

function dueLabel(sheet) {
  const date = formatStamp(sheet.due_date);
  const time = formatClockLabel(sheet.due_time);
  if (date && time) return `${date} ${time}`;
  return date || time || '';
}

function display(value, fallback = '—') {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function yesNo(value) {
  return value ? 'Yes' : 'No';
}

function finishingLabel(value) {
  const text = String(value || '').trim();
  return text || 'None';
}

function Barcode({ svg, className }) {
  const source = typeof svg === 'string' ? svg.trim() : '';
  if (!source.startsWith('<svg')) {
    return <div className={[className, 'wo-barcode-missing'].filter(Boolean).join(' ')}>barcode unavailable</div>;
  }
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  return (
    <div className={className}>
      <img src={src} alt="" />
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="wo-field">
      <span className="wo-label">{label}</span>
      <span className="wo-value">{display(value)}</span>
    </div>
  );
}

function SpecBlock({ item, special }) {
  return (
    <div className="wo-spec-block">
      {item.description ? <div className="wo-spec-title">{item.description}</div> : null}
      <div className="wo-spec-grid">
        <div>
          <Field label="Size:" value={item.size} />
          <Field label="Quantity:" value={item.quantity} />
          <Field label="Media:" value={item.media} />
          <Field label="Color:" value={item.color} />
          <Field label="Binding / Finish:" value={item.binding_finish} />
        </div>
        <div>
          <Field label="Mounting:" value={yesNo(item.mount)} />
          <Field label="Lamination:" value={yesNo(item.laminate)} />
          <Field label="Finishing:" value={finishingLabel(item.finishing)} />
          {special != null ? <Field label="Special Instructions:" value={special} /> : null}
        </div>
      </div>
    </div>
  );
}

function WorkOrderSheet({ payload, sheet }) {
  const history = sheet.production_history || [];
  const showStaff = Boolean(payload.staff_history);
  const items = sheet.line_items || [];
  const serviceLabel = sheet.service_name || sheet.routing?.department || 'GENERAL';
  const due = dueLabel(sheet);

  return (
    <article className="work-order-sheet">
      <header className="wo-header">
        <div>
          <img className="wo-logo" src="/logo.png" alt="LaunchPad 3.0" />
          <div className="wo-shop">
            <strong>{payload.shop?.name}</strong>
            {(payload.shop?.address_lines || []).map((line) => (
              <div key={line}>{line}</div>
            ))}
            {payload.shop?.phone ? <div>{payload.shop.phone}</div> : null}
          </div>
        </div>
        <div className="wo-barcode-block">
          <Barcode svg={sheet.barcode_svg} className="wo-barcode wo-barcode-lg" />
          <div className="wo-number">{sheet.barcode_value}</div>
        </div>
      </header>

      <h1 className="wo-title">WORK ORDER</h1>

      <div className="wo-meta">
        <div>ORDER #: {sheet.barcode_value}</div>
        <div className="wo-meta-right">
          <div>DATE/TIME SUBMITTED: {display(formatStamp(sheet.submitted_at))}</div>
          {due ? <div>DUE: {due}</div> : null}
        </div>
      </div>

      <div className="wo-columns">
        <section className="wo-panel">
          <h2>CONTACT INFORMATION</h2>
          <div className="wo-panel-body">
            <Field label="Company:" value={sheet.contact?.company} />
            <Field label="Contact:" value={sheet.contact?.contact_name} />
            <Field label="Phone:" value={sheet.contact?.phone} />
            <Field label="Email:" value={sheet.contact?.email} />
          </div>
        </section>
        <section className="wo-panel">
          <h2>PROJECT INFORMATION</h2>
          <div className="wo-panel-body">
            <Field label="PO Number:" value={sheet.project?.po_number} />
            <Field label="Project Number:" value={sheet.project?.project_number} />
            <Field label="Project Name:" value={sheet.project?.project_name} />
            <Field label="Notes:" value={sheet.project?.notes} />
          </div>
        </section>
        <section className="wo-panel">
          <h2>DELIVERY INFORMATION</h2>
          <div className="wo-panel-body">
            <Field label="Delivery Method:" value={sheet.delivery?.method} />
            <Field label="Ship To:" value={sheet.delivery?.ship_to} />
            <Field label="Attention:" value={sheet.delivery?.attention} />
            <Field label="Delivery Window:" value={payload.delivery_window_label} />
          </div>
        </section>
      </div>

      <section className="wo-section">
        <h2 className="wo-section-title">SPECIFICATIONS ({String(serviceLabel).toUpperCase()})</h2>
        {sheet.process ? <div className="wo-process"><strong>Process:</strong> {sheet.process}</div> : null}
        {items.length ? items.map((item, index) => (
          <SpecBlock
            key={item.id}
            item={item}
            special={index === items.length - 1 ? sheet.special_instructions : null}
          />
        )) : (
          <div className="wo-empty">{sheet.specifications || 'No specifications recorded.'}</div>
        )}
        {items.length === 0 && sheet.special_instructions ? (
          <div className="wo-panel-body">
            <Field label="Special Instructions:" value={sheet.special_instructions} />
          </div>
        ) : null}
      </section>

      <section className="wo-section">
        <h2 className="wo-section-title">ATTACHED FILES</h2>
        {(sheet.files || []).length ? (
          <table className="wo-table">
            <thead>
              <tr>
                <th>File Name</th>
                <th>Uploaded</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {sheet.files.map((file) => (
                <tr key={file.id}>
                  <td>{file.original_name}</td>
                  <td>{display(formatStamp(file.uploaded_at))}</td>
                  <td>{formatFileSize(file.size_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="wo-empty">No files are attached.</div>}
      </section>

      <div className="wo-split">
        <section className="wo-panel">
          <h2>ROUTING INFORMATION</h2>
          <div className="wo-panel-body">
            <Field label="Department:" value={sheet.routing?.department} />
            <Field label="Current Status:" value={sheet.routing?.current_status_label || sheet.routing?.current_status} />
            <Field label="Next Department:" value={sheet.routing?.next_department} />
          </div>
        </section>
        <section className="wo-panel">
          <h2>SCAN INSTRUCTIONS</h2>
          <div className="wo-panel-body">
            <ol className="wo-scan-copy">
              {(payload.scan_instructions || []).map((line) => <li key={line}>{line}</li>)}
            </ol>
            <div className="scan-barcode-wrap">
              <Barcode svg={sheet.barcode_svg} className="wo-barcode" />
              <div className="scan-laser" />
            </div>
          </div>
        </section>
      </div>

      <section className="wo-section">
        <h2 className="wo-section-title">PRODUCTION HISTORY</h2>
        {history.length ? (
          <table className="wo-table">
            <thead>
              <tr>
                <th>Department</th>
                <th>Status</th>
                <th>Date / Time</th>
                {showStaff ? <th>Scanned By</th> : null}
                {showStaff ? <th>Notes</th> : null}
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td>{display(row.department)}</td>
                  <td>{display(row.status_label || row.status)}</td>
                  <td>{display(formatStamp(row.event_time))}</td>
                  {showStaff ? <td>{display(row.scanned_by)}</td> : null}
                  {showStaff ? <td>{display(row.notes)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="wo-empty">No production history recorded.</div>}
      </section>

      <footer className="wo-footer">
        <div className="wo-footer-row">
          <span>Work Order: {sheet.barcode_value}</span>
          <span>Generated: {display(formatStamp(payload.generated_at))}</span>
        </div>
        <p className="wo-thanks">THANK YOU FOR YOUR BUSINESS!</p>
      </footer>
    </article>
  );
}

export default function WorkOrderPrint() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const isOrder = location.pathname.startsWith('/orders/');
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const path = isOrder ? `/api/orders/${id}/print` : `/api/workorders/${id}/print`;
    authFetch(path)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Work order not found');
        return body;
      })
      .then((body) => {
        if (!cancelled) setPayload(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Work order not found');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, isOrder]);

  function goBack() {
    navigate(isOrder ? `/orders/${id}` : `/work-orders/${id}`);
  }

  function printDocument() {
    const sheets = payload?.work_orders || [];
    const previous = document.title;
    if (sheets.length === 1) document.title = sheets[0].barcode_value || 'Work Order';
    else if (payload?.order_number) document.title = `Order ${payload.order_number}`;
    window.print();
    window.setTimeout(() => {
      document.title = previous;
    }, 0);
  }

  const count = payload?.work_orders?.length || 0;

  return (
    <div className="print-page">
      <div className="print-toolbar no-print">
        <button type="button" className="toolbar-back" onClick={goBack}>Back</button>
        <div className="toolbar-actions">
          {count > 1 ? <span className="toolbar-note">{count} work orders</span> : null}
          <span className="toolbar-note">Download PDF uses the browser print dialog.</span>
          <button type="button" className="toolbar-print" onClick={printDocument} disabled={!payload}>Print</button>
          <button type="button" className="toolbar-pdf" onClick={printDocument} disabled={!payload}>Download PDF</button>
        </div>
      </div>
      <div className="print-stage">
        {loading ? <LoadingState message="Loading work order..." /> : null}
        {error ? <ErrorState message={error} /> : null}
        {payload ? (payload.work_orders || []).map((sheet) => (
          <WorkOrderSheet key={sheet.id} payload={payload} sheet={sheet} />
        )) : null}
        {payload && count === 0 ? <ErrorState message="This order has no work orders to print." /> : null}
      </div>
    </div>
  );
}
