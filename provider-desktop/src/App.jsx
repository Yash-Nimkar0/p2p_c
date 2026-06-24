import { useState, useEffect, useRef } from 'react';

function App() {
  const [status, setStatus] = useState('stopped');
  const [logs, setLogs] = useState([]);
  const [mockMode, setMockMode] = useState(true);
  
  // Real-time stats
  const [earnings, setEarnings] = useState(0);
  const [requestsServed, setRequestsServed] = useState(0);
  const [tokensGenerated, setTokensGenerated] = useState(0);
  
  const logsEndRef = useRef(null);

  useEffect(() => {
    let unlistenStatus;
    let unlistenLog;

    if (window.electronAPI) {
      unlistenStatus = window.electronAPI.onPythonStatus((newStatus) => {
        setStatus(newStatus);
        if (newStatus === 'stopped') {
          setEarnings(0);
          setRequestsServed(0);
          setTokensGenerated(0);
        }
      });

      unlistenLog = window.electronAPI.onPythonLog((logPayload) => {
        // If it's our structured JSON log from the provider node
        if (logPayload.type === 'log') {
          setEarnings(logPayload.earnings_usd || 0);
          setRequestsServed(logPayload.requests_served || 0);
          setTokensGenerated(logPayload.tokens_generated || 0);
          
          setLogs((prev) => {
            const newLogs = [...prev, { level: logPayload.level, text: `[${logPayload.timestamp}] ${logPayload.message}` }];
            if (newLogs.length > 100) newLogs.shift();
            return newLogs;
          });
        } else {
          // Fallback for raw text or raw python print statements
          setLogs((prev) => {
            const newLogs = [...prev, { level: logPayload.level || 'INFO', text: logPayload.text || JSON.stringify(logPayload) }];
            if (newLogs.length > 100) newLogs.shift();
            return newLogs;
          });
        }
      });
    }

    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenLog) unlistenLog();
    };
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleStart = () => {
    setStatus('starting');
    setLogs([]); // clear logs on start
    window.electronAPI?.startNode({ mock: mockMode });
  };

  const handleStop = () => {
    setStatus('stopping');
    window.electronAPI?.stopNode();
  };

  return (
    <div className="container">
      <header className="header">
        <h1>MeshGPU Node</h1>
        <div className={`status-badge ${status}`}>
          {status === 'stopped' ? 'OFFLINE' : status.toUpperCase()}
        </div>
      </header>

      <div className="controls">
        <label className="toggle">
          <input 
            type="checkbox" 
            checked={mockMode} 
            onChange={(e) => setMockMode(e.target.checked)} 
            disabled={status !== 'stopped'}
          />
          Mock GPU (Simulation Mode)
        </label>
        
        <div className="actions">
          {status === 'stopped' ? (
            <button className="start-btn" onClick={handleStart}>
              START EARNING
            </button>
          ) : (
            <button className="stop-btn" onClick={handleStop} disabled={status === 'stopping'}>
              STOP NODE
            </button>
          )}
        </div>
      </div>

      <div className="dashboard">
        <div className="panel">
          <h2>Pending Balance</h2>
          <div className="stat-value green">
            ${earnings.toFixed(4)}
          </div>
        </div>
        <div className="panel">
          <h2>Tokens Generated</h2>
          <div className="stat-value">
            {tokensGenerated.toLocaleString()}
          </div>
        </div>
        <div className="panel">
          <h2>Requests Served</h2>
          <div className="stat-value">
            {requestsServed.toLocaleString()}
          </div>
        </div>
      </div>

      <div className="log-panel">
        <h2>Live Event Stream <span style={{fontSize: '0.7rem', color: 'var(--accent-cyan)'}}>● LIVE</span></h2>
        <div className="logs">
          {logs.map((log, i) => (
            <div key={i} className={`log-line ${log.level ? log.level.toLowerCase() : 'info'}`}>
              <span className="log-level">[{log.level || 'INFO'}]</span> {log.text}
            </div>
          ))}
          {logs.length === 0 && <div className="log-line dim">Awaiting node initialization...</div>}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}

export default App;
