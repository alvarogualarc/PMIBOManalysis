import React, { useRef, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  ColDef,
  GridReadyEvent,
  RowClickedEvent,
  ModuleRegistry,
} from 'ag-grid-community';
import { ClientSideRowModelModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';

ModuleRegistry.registerModules([ClientSideRowModelModule]);

interface BOMGridProps {
  rowData: any[];
  columnDefs: ColDef[];
  title?: string;
  onRowClick?: (row: any) => void;
  height?: string;
}

const defaultColDef: ColDef = {
  filter: true,
  sortable: true,
  resizable: true,
  minWidth: 80,
};

export default function BOMGrid({ rowData, columnDefs, title, onRowClick, height = '420px' }: BOMGridProps) {
  const gridRef = useRef<AgGridReact>(null);

  const onGridReady = useCallback((_: GridReadyEvent) => {
    gridRef.current?.api?.sizeColumnsToFit();
  }, []);

  const onFirstDataRendered = useCallback(() => {
    gridRef.current?.api?.sizeColumnsToFit();
  }, []);

  const onRowClicked = useCallback(
    (e: RowClickedEvent) => {
      onRowClick?.(e.data);
    },
    [onRowClick]
  );

  const handleExport = useCallback(() => {
    gridRef.current?.api?.exportDataAsCsv({
      fileName: `${title ?? 'pmi-bom-export'}.csv`,
    });
  }, [title]);

  const rowCount = rowData?.length ?? 0;

  return (
    <div className="flex flex-col gap-2">
      {(title || true) && (
        <div className="flex items-center justify-between">
          {title && <h3 className="text-sm font-semibold text-slate-700">{title}</h3>}
          <button
            onClick={handleExport}
            className="ml-auto flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white rounded"
            style={{ background: '#003087' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" />
            </svg>
            Export CSV
          </button>
        </div>
      )}

      <div
        className="ag-theme-quartz"
        style={{
          height,
          width: '100%',
          '--ag-header-background-color': '#003087',
          '--ag-header-foreground-color': '#ffffff',
          '--ag-header-column-separator-color': 'rgba(255,255,255,0.2)',
          '--ag-header-column-resize-handle-color': 'rgba(255,255,255,0.4)',
          '--ag-row-hover-color': '#EFF6FF',
          '--ag-selected-row-background-color': '#DBEAFE',
          '--ag-font-size': '12px',
          '--ag-row-height': '32px',
          '--ag-header-height': '38px',
        } as React.CSSProperties}
      >
        <AgGridReact
          ref={gridRef}
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          pagination={true}
          paginationPageSize={50}
          onGridReady={onGridReady}
          onFirstDataRendered={onFirstDataRendered}
          onRowClicked={onRowClicked}
          rowSelection="single"
          animateRows={true}
          suppressCellFocus={true}
        />
      </div>

      <div className="text-xs text-slate-500 text-right">
        {rowCount.toLocaleString()} row{rowCount !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
