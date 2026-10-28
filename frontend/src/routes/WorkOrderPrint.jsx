import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { authFetch } from '../api';
import { formatClockLabel, formatFileSize, formatShopStamp, timezoneLabel } from '../brand';
import ErrorState from '../components/ErrorState';
import LoadingState from '../components/LoadingState';
import { useDocumentTitle } from '../useDocumentTitle';
import './workOrderPrint.css';

const WRITE_IN_COLUMNS = [
  { key: 'code', label: 'Code', width: '18%' },
  { key: 'unit', label: 'Unit', width: '12%' },
  { key: 'quantity', label: 'Quantity', width: '22%' },
  { key: 'description', label: 'Description', width: '33%' },
  { key: 'price', label: 'Price', width: '15%' },
];
const WRITE_IN_ROWS = 6;

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

function shopStamp(value, timeZone) {
  return formatShopStamp(value, timeZone) || formatStamp(value);
}

function dueLabel(sheet) {
  const date = formatStamp(sheet.due_date);
  const time = formatClockLabel(sheet.due_time);
  const wall = [sheet.due_date, sheet.due_time].filter(Boolean).join(' ');
  const zone = timezoneLabel(sheet.timezone, wall);
  const main = [date, time].filter(Boolean).join(' ');
  if (!main) return '';
  return zone ? `${main} ${zone}` : main;
}

function isActiveStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  return value === 'open' || value === 'in-progress';
}

function specGroups(rows, width = 3) {
  const groups = [];
  for (let index = 0; index < rows.length; index += width) {
    groups.push(rows.slice(index, index + width));
  }
  return groups;
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

function isProofField(field) {
  if (!field) return false;
  if (field.key === 'proof') return true;
  return /^proof$/i.test(String(field.label || '').replace(/:$/, '').trim());
}

function cityLine(parts) {
  if (!parts) return '';
  const city = String(parts.city || '').trim();
  const state = String(parts.state || '').trim();
  const zip = String(parts.zip || '').trim();
  const region = [state, zip].filter(Boolean).join(' ');
  return [city, region].filter(Boolean).join(', ');
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

function Field({ label, value, prominent = false }) {
  return (
    <div className="wo-field">
      <span className="wo-label">{label}</span>
      <span className={prominent ? 'wo-value wo-customer-name' : 'wo-value'}>
        {display(value)}
      </span>
    </div>
  );
}

function billToPresent(bill) {
  if (!bill) return false;
  return ['name', 'phone', 'email', 'company', 'line1', 'line2', 'city', 'state', 'zip'].some((key) => String(bill[key] || '').trim());
}

function detailRows(item) {
  const dynamic = Array.isArray(item.fields) && item.fields.length ? item.fields : null;
  if (!dynamic) {
    return [
      ['Size', item.size],
      ['Media', item.media],
      ['Color', item.color],
      ['Binding / Finish', item.binding_finish],
      ['Mounting', item.mount_label || yesNo(item.mount)],
      ['Lamination', item.laminate_label || yesNo(item.laminate)],
      ['Finishing', finishingLabel(item.finishing)],
    ];
  }
  const keys = new Set(dynamic.map((field) => field.key));
  const rows = dynamic
    .filter((field) => !isProofField(field))
    .map((field) => [field.label, field.display]);
  if (!keys.has('mount')) rows.push(['Mounting', item.mount_label || yesNo(item.mount)]);
  if (!keys.has('laminate')) rows.push(['Lamination', item.laminate_label || yesNo(item.laminate)]);
  if (!keys.has('finishing')) rows.push(['Finishing', finishingLabel(item.finishing)]);
  return rows;
}

function proofRows(items) {
  const rows = [];
  for (const item of items) {
    const proof = (item.fields || []).find(isProofField);
    if (!proof) continue;
    rows.push({
      title: item.description || '',
      value: proof.display,
    });
  }
  return rows;
}

function Section({ title, children, keep = false }) {
  return (
    <section className={keep ? 'wo-section wo-keep' : 'wo-section'}>
      <h2 className="wo-section-title">{title}</h2>
      {children}
    </section>
  );
}

function AddressFields({ address }) {
  if (!address) return null;
  return (
    <>
      <Field label="Addr 1" value={address.line1} />
      {address.line2 ? <Field label="Addr 2" value={address.line2} /> : null}
      <Field label="City" value={cityLine(address) || address.city} />
    </>
  );
}

function LineBlock({ item }) {
  const rows = detailRows(item);
  return (
    <div className="wo-line">
      <div className="wo-line-head">
        <span className="wo-line-num">{item.line_number || ''}</span>
        <div className="wo-summary">{display(item.description, 'Line item')}</div>
        <span className="wo-line-qty">{item.quantity ? `Qty ${item.quantity}` : ''}</span>
      </div>
      {rows.length ? (
        <table className="wo-spec-table">
          <tbody>
            {specGroups(rows).map((group, groupIndex) => (
              <tr key={group.map(([label]) => label).join('|') || groupIndex}>
                {group.map(([label, value]) => (
                  <React.Fragment key={label}>
                    <th scope="row">{label}</th>
                    <td>{display(value)}</td>
                  </React.Fragment>
                ))}
                {group.length < 3 ? <td className="wo-spec-pad" colSpan={(3 - group.length) * 2} /> : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function WriteInGrid() {
  return (
    <table className="wo-write-grid">
      <colgroup>
        {WRITE_IN_COLUMNS.map((column) => (
          <col key={column.key} style={{ width: column.width }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {WRITE_IN_COLUMNS.map((column) => (
            <th key={column.key} scope="col">{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: WRITE_IN_ROWS }, (_, row) => (
          <tr key={row}>
            {WRITE_IN_COLUMNS.map((column) => (
              <td key={column.key}>&nbsp;</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WorkOrderSheet({ payload, sheet }) {
  const history = sheet.production_history || [];
  const showStaff = Boolean(payload.staff_history);
  const items = sheet.line_items || [];
  const proofs = proofRows(items);
  const due = dueLabel(sheet);
  const rush = String(sheet.priority || '').trim().toLowerCase() === 'rush';
  const overdue = Boolean(sheet.overdue) && isActiveStatus(sheet.routing?.current_status);
  const companyName = String(sheet.contact?.company || '').trim();
  const contactName = String(sheet.contact?.contact_name || '').trim();
  const customerName = companyName || contactName;
  const continuation = [sheet.barcode_value, customerName].filter((part) => String(part || '').trim()).join(' · ');
  const zone = sheet.timezone;
  const instructions = (payload.scan_instructions || []).join(' ');
  const shopLines = [
    payload.shop?.name,
    payload.location?.name || payload.shop?.location_name,
    ...((payload.location?.address_lines || payload.shop?.address_lines || []).filter((line) => String(line || '').trim())),
    payload.location?.phone || payload.shop?.phone,
  ].filter((line) => String(line || '').trim());
  const projectNotes = String(sheet.project?.notes || '').trim();
  const special = String(sheet.special_instructions || '').trim();

  return (
    <article className="work-order-sheet">
      <table className="wo-flow">
        <thead>
          <tr>
            <th>
              <div className="wo-continue">{continuation}</div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
      <header className="wo-band">
        <div className="wo-band-main">
          <img className="wo-logo" src="/brand/logo-print.png" alt="Launchpad" />
          <div className="wo-band-copy">
            <div className="wo-kicker">Work Order</div>
            {(payload.location?.name || payload.shop?.location_name) ? (
              <div className="wo-location" data-testid="print-location">
                <div className="wo-location-name">{payload.location?.name || payload.shop?.location_name}</div>
                {(payload.location?.address_lines || []).map((line) => (
                  <div key={line} className="wo-location-line">{line}</div>
                ))}
                {(payload.location?.phone || payload.shop?.phone) ? (
                  <div className="wo-location-line">{payload.location?.phone || payload.shop?.phone}</div>
                ) : null}
              </div>
            ) : null}
            <div className="wo-number">{display(sheet.barcode_value, '')}</div>
          </div>
        </div>
        <div className="wo-barcode-block">
          <Barcode svg={sheet.barcode_svg} className="wo-barcode" />
          <div className="wo-barcode-text">{display(sheet.barcode_value, '')}</div>
          {instructions ? <div className="wo-scan-note">{instructions}</div> : null}
        </div>
      </header>

      <div className="wo-facts">
        <div>
          <div className="wo-fact-label">Order date</div>
          <div className="wo-fact-value">{display(shopStamp(sheet.submitted_at, zone))}</div>
          {sheet.order_number ? <div className="wo-fact-sub">Order {sheet.order_number}</div> : null}
        </div>
        <div className="wo-fact-due">
          <div className="wo-fact-label">Due</div>
          <div className="wo-fact-value">{display(due)}</div>
        </div>
        <div className="wo-fact-delivery">
          <div className="wo-fact-label">Delivery</div>
          <div className="wo-fact-value">{display(sheet.delivery?.method)}</div>
          {sheet.delivery?.hours_label ? <div className="wo-fact-sub">{sheet.delivery.hours_label}</div> : null}
        </div>
        {(rush || overdue) ? (
          <div className="wo-flags">
            {rush ? <div className="wo-flag wo-flag-rush">RUSH</div> : null}
            {overdue ? <div className="wo-flag wo-flag-overdue">OVERDUE</div> : null}
          </div>
        ) : null}
      </div>
            </td>
          </tr>
          <tr>
            <td>
      <div className="wo-columns">
        <Section title="CUSTOMER">
          <div className="wo-panel-body">
            <Field label="Company" value={sheet.contact?.company} prominent={Boolean(companyName)} />
            <Field label="Contact" value={sheet.contact?.contact_name} prominent={!companyName && Boolean(contactName)} />
            <Field label="Phone" value={sheet.contact?.phone} />
            <Field label="Email" value={sheet.contact?.email} />
            <AddressFields address={sheet.address} />
          </div>
        </Section>
        <Section title="BILL TO / SHIP TO / DELIVERY">
          <div className="wo-panel-body">
            <Field label="Method" value={sheet.delivery?.method} />
            <Field label="Return" value={sheet.return_to_label} />
            {sheet.delivery?.ups_account_number ? (
              <Field label="UPS Account" value={sheet.delivery.ups_account_number} />
            ) : null}
            <Field label="Ship To" value={sheet.delivery?.ship_to} />
            <Field label="Attention" value={sheet.delivery?.attention} />
            {billToPresent(sheet.bill_to) ? (
              <>
                <Field label="Bill To" value={sheet.bill_to.name} />
                <Field label="Bill Phone" value={sheet.bill_to.phone} />
                <Field label="Bill Email" value={sheet.bill_to.email} />
                <Field label="Bill Company" value={sheet.bill_to.company} />
                <Field label="Bill Addr 1" value={sheet.bill_to.line1} />
                {sheet.bill_to.line2 ? <Field label="Bill Addr 2" value={sheet.bill_to.line2} /> : null}
                <Field label="Bill City" value={cityLine(sheet.bill_to)} />
              </>
            ) : <Field label="Bill To" value="" />}
          </div>
        </Section>
      </div>
            </td>
          </tr>
          <tr>
            <td>
      <Section title="JOB DETAILS">
        <div className="wo-meta-line">
          <span><strong>Service:</strong> {display(sheet.service_name)}</span>
          <span><strong>Department:</strong> {display(sheet.routing?.department)}</span>
          <span><strong>Status:</strong> {display(sheet.routing?.current_status_label || sheet.routing?.current_status)}</span>
          <span><strong>Next:</strong> {display(sheet.routing?.next_department)}</span>
        </div>
        <div className="wo-panel-body">
          <Field label="Project" value={sheet.project?.project_name} />
          <Field label="Project #" value={sheet.project?.project_number} />
          <Field label="PO Number" value={sheet.project?.po_number} />
          {sheet.process ? <Field label="Process" value={sheet.process} /> : null}
        </div>
        {items.length ? items.map((item) => (
          <LineBlock key={item.id} item={item} />
        )) : (
          <div className="wo-empty">{sheet.specifications || 'No specifications recorded.'}</div>
        )}
      </Section>
            </td>
          </tr>
          <tr>
            <td>
      <Section title="ORIGINALS / FILES">
        <div className="wo-panel-body">
          <Field label="Originals" value={sheet.originals_source_label || 'Not specified'} />
          {sheet.originals_pickup ? (
            <div className="wo-note">Inbound pickup of originals. This is separate from the delivery method.</div>
          ) : null}
        </div>
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
                  <td data-label="File Name">{file.original_name}</td>
                  <td data-label="Uploaded">{display(shopStamp(file.uploaded_at, zone))}</td>
                  <td data-label="Size">{formatFileSize(file.size_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="wo-empty">No files are attached.</div>}
      </Section>
            </td>
          </tr>
          <tr>
            <td>
      <div className="wo-columns">
        <Section title="SPECIAL INSTRUCTIONS">
          <div className="wo-panel-body">
            <div className="wo-value">{display(special)}</div>
            {projectNotes && projectNotes !== special ? (
              <div className="wo-note">Project notes: {projectNotes}</div>
            ) : null}
          </div>
        </Section>
        <Section title="PROOF">
          <div className="wo-panel-body">
            {proofs.length ? proofs.map((row, index) => (
              <Field
                key={`${index}-${row.value}`}
                label={proofs.length > 1 ? `Line ${index + 1}` : 'Proof'}
                value={row.value || 'Not specified'}
              />
            )) : <Field label="Proof" value="Not specified" />}
          </div>
        </Section>
      </div>
            </td>
          </tr>
          <tr>
            <td>
      <Section title="PAYMENT METHOD">
        <div className="wo-panel-body">
          <Field label="Payment" value={sheet.payment_method_label || 'Not specified'} />
        </div>
      </Section>
            </td>
          </tr>
          <tr>
            <td>
      <Section title="PRODUCTION HISTORY">
        {history.length ? (
          <table className="wo-table">
            <thead>
              <tr>
                <th>Department</th>
                <th>Status</th>
                <th>Date / Time</th>
                {showStaff ? <th>Recorded By</th> : null}
                {showStaff ? <th>Notes</th> : null}
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td data-label="Department">{display(row.department)}</td>
                  <td data-label="Status">{display(row.status_label || row.status)}</td>
                  <td data-label="Date / Time">{display(shopStamp(row.event_time, zone))}</td>
                  {showStaff ? <td data-label="Recorded By">{display(row.scanned_by)}</td> : null}
                  {showStaff ? <td data-label="Notes">{display(row.notes)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="wo-empty">No production history recorded.</div>}
      </Section>
            </td>
          </tr>
          <tr>
            <td>
      <div className="wo-end">
        <WriteInGrid />

        <footer className="wo-footer">
          <div className="wo-footer-main">
            <div className="wo-shop-footer">
              {shopLines.map((line) => <div key={line}>{line}</div>)}
            </div>
            <div className="wo-footer-meta">
              <div>Printed {display(shopStamp(payload.generated_at, zone))}</div>
            </div>
          </div>
          <div className="wo-credit" data-testid="division-credit">
            <div className="wo-credit-logos">
              <img className="wo-credit-ai" src="/brand/accent-imaging-logo-print.png" alt="Accent Imaging" />
              <img className="wo-credit-acg" src="/brand/acg-logo-print.png" alt="Accent Corporate Graphics" />
            </div>
            <div className="wo-credit-text">A service of Accent Imaging and Accent Corporate Graphics</div>
          </div>
        </footer>
      </div>
            </td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}

export default function WorkOrderPrint() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const isOrder = location.pathname.startsWith('/orders/');
  const [payload, setPayload] = useState(null);
  useDocumentTitle('Print Work Order');
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
