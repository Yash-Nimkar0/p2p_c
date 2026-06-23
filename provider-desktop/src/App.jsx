import { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [status, setStatus] = useState('stopped');
  const [logs, setLogs] = useState([]);
  const [mockMode, setMockMode] = useState(true);

  useEffect(() => {
    let unlistenStatus;
    let unlistenLog;
    if (window.electronAPI) {
      unlistenStatus = window.electronAPI.onPythonStatus((newStatus) => {
        setStatus(newStatus);
      });

      unlistenLog = window.electronAPI.onPythonLog((log) => {
        setLogs((prevLogs) => {
          const newLogs = [...prevLogs, log];
          if (newLogs.length > 50) newLogs.shift();
          return newLogs;
        });
      });
    }
    return () => {
      if (unlistenStatus) unlistenStatus();
      if (unlistenLog) unlistenLog();
    };
  }, []);

  const handleStart = () => {
    setStatus('starting');
    window.electronAPI?.startNode({ mock: mockMode });
  };

  const handleStop = () => {
    setStatus('stopping');
    window.electronAPI?.stopNode();
  };

  return (
    <div className="container">
      <header className="header">
        <h1>MeshGPU Provider Node</h1>
        <div className={`status-badge ${status}`}>
          {status.toUpperCase()}
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
          Use Mock Mode (No real GPU)
        </label>
        
        <div className="actions">
          {status === 'stopped' ? (
            <button className="start-btn" onClick={handleStart}>
              Start Earning
            </button>
          ) : (
            <button className="stop-btn" onClick={handleStop} disabled={status === 'stopping'}>
              Stop Node
            </button>
          )}
        </div>
      </div>

      <div className="dashboard">
        <div className="panel">
          <h2>Earnings (Session)</h2>
          <div className="stat-value">$0.0000</div>
        </div>
        <div className="panel">
          <h2>Requests Served</h2>
          <div className="stat-value">0</div>
        </div>
      </div>

      <div className="log-panel">
        <h2>System Logs</h2>
        <div className="logs">
          {logs.map((log, i) => (
            <div key={i} className={`log-line ${log.level.toLowerCase()}`}>
              <span className="log-level">[{log.level}]</span> {log.text}
            </div>
          ))}
          {logs.length === 0 && <div className="log-line dim">No logs yet...</div>}
        </div>
      </div>
    </div>
  );
}

export default App;
