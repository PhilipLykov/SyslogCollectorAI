import { useState, useEffect, useCallback } from 'react';
import {
  type UserInfo,
  type CurrentUser,
  fetchUsers,
  createUser,
  updateUser,
  resetUserPassword,
  toggleUserActive,
  deleteUser,
} from '../api';

const ROLES = [
  { value: 'administrator', label: 'Administrator' },
  { value: 'auditor', label: 'Auditor' },
  { value: 'monitoring_agent', label: 'Monitoring Agent' },
];

interface Props {
  onAuthError: () => void;
  currentUser?: CurrentUser | null;
}

export function UserManagementSection({ onAuthError, currentUser }: Props) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Create user form
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('monitoring_agent');
  const [creating, setCreating] = useState(false);

  // Edit user
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset password
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchUsers();
      setUsers(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) onAuthError();
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setCreating(true);
    try {
      await createUser({
        username: newUsername.trim(),
        password: newPassword,
        display_name: newDisplayName.trim() || undefined,
        email: newEmail.trim() || undefined,
        role: newRole,
        must_change_password: true,
      });
      setSuccess(`User "${newUsername.trim()}" created successfully.`);
      setShowCreate(false);
      setNewUsername('');
      setNewPassword('');
      setNewDisplayName('');
      setNewEmail('');
      setNewRole('monitoring_agent');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = (u: UserInfo) => {
    setEditingId(u.id);
    setEditDisplayName(u.display_name ?? '');
    setEditEmail(u.email ?? '');
    setEditRole(u.role);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      await updateUser(editingId, {
        display_name: editDisplayName.trim() || undefined,
        email: editEmail.trim() || undefined,
        role: editRole,
      });
      setSuccess('User updated.');
      setEditingId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const isSelf = (u: UserInfo) => currentUser?.id === u.id;

  const handleToggleActive = async (u: UserInfo) => {
    if (isSelf(u)) {
      setError('You cannot disable your own account.');
      return;
    }
    setError('');
    setSuccess('');
    try {
      await toggleUserActive(u.id);
      setSuccess(`User "${u.username}" ${u.is_active ? 'disabled' : 'enabled'}.`);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (u: UserInfo) => {
    if (isSelf(u)) {
      setError('You cannot delete your own account.');
      return;
    }
    if (!confirm(`Deactivate user "${u.username}"? This will invalidate all their sessions.`)) return;
    setError('');
    setSuccess('');
    try {
      await deleteUser(u.id);
      setSuccess(`User "${u.username}" deactivated.`);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleResetPw = async () => {
    if (!resetId || !resetPw) return;
    setError('');
    setSuccess('');
    setResetting(true);
    try {
      const result = await resetUserPassword(resetId, resetPw);
      setSuccess(result.message);
      setResetId(null);
      setResetPw('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  };

  const fmtDate = (d: string | null) => {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    const hh = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
  };

  if (loading) {
    return (
      <div className="settings-loading">
        <div className="spinner" />
        Loading users…
      </div>
    );
  }

  return (
    <div className="admin-section">
      <h3 className="section-title">User Management</h3>
      <p className="section-desc">
        Create and manage user accounts, assign roles, and control access to the system.
      </p>

      {error && <div className="error-msg" role="alert">{error}</div>}
      {success && <div className="success-msg" role="status">{success}</div>}

      {/* ── Create User ── */}
      <div className="admin-block">
        <button type="button" className="prompt-toggle" onClick={() => setShowCreate(!showCreate)}>
          <span className={`prompt-chevron${showCreate ? ' open' : ''}`}>&#9654;</span>
          Create New User
          <span className="prompt-custom-badge">{users.length} user(s)</span>
        </button>

        {showCreate && (
          <form className="admin-form-panel" onSubmit={handleCreate}>
            <div className="admin-form-grid">
              <div className="form-group">
                <label>Username *</label>
                <input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} required minLength={3} placeholder="min 3 characters" />
              </div>
              <div className="form-group">
                <label>Password *</label>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={12} placeholder="min 12 chars, mixed case, digit, special" />
              </div>
              <div className="form-group">
                <label>Display Name</label>
                <input type="text" value={newDisplayName} onChange={(e) => setNewDisplayName(e.target.value)} placeholder="Optional" />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Optional" />
              </div>
              <div className="form-group">
                <label>Role</label>
                <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            </div>
            <div className="admin-form-actions">
              <button type="submit" className="btn btn-sm" disabled={creating || !newUsername.trim() || !newPassword}>
                {creating ? 'Creating…' : 'Create User'}
              </button>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </form>
        )}
      </div>

      {/* ── Users Table ── */}
      <div className="admin-block">
        <div className="table-responsive">
          <table className="admin-table" aria-label="Users">
            <thead>
              <tr>
                <th>Username</th>
                <th>Display Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.is_active ? '' : 'admin-row-inactive'}>
                  <td><strong>{u.username}</strong></td>
                  <td>
                    {editingId === u.id ? (
                      <input type="text" value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} className="admin-inline-input" />
                    ) : (
                      u.display_name || '—'
                    )}
                  </td>
                  <td>
                    {editingId === u.id ? (
                      <select value={editRole} onChange={(e) => setEditRole(e.target.value)} className="admin-inline-select">
                        {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    ) : (
                      <span className={`admin-role-badge admin-role-${u.role}`}>
                        {u.role.replace(/_/g, ' ')}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`db-status-badge ${u.is_active ? 'db-status-success' : 'db-status-failed'}`}>
                      {u.is_active ? 'Active' : 'Disabled'}
                    </span>
                    {u.locked_until && new Date(u.locked_until) > new Date() && (
                      <span className="db-status-badge db-status-completed_with_errors" style={{ marginLeft: '4px' }}>Locked</span>
                    )}
                  </td>
                  <td className="admin-date-cell">{fmtDate(u.last_login_at)}</td>
                  <td>
                    <div className="admin-action-group">
                      {editingId === u.id ? (
                        <>
                          <button className="btn btn-xs" onClick={handleSaveEdit} disabled={saving}>Save</button>
                          <button className="btn btn-xs btn-outline" onClick={() => setEditingId(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-xs btn-outline" onClick={() => handleEdit(u)}>Edit</button>
                          <button className="btn btn-xs btn-outline" onClick={() => { setResetId(u.id); setResetPw(''); }}>Reset PW</button>
                          {!isSelf(u) && (
                            <button
                              className={`btn btn-xs ${u.is_active ? 'btn-outline' : 'btn-outline'}`}
                              onClick={() => handleToggleActive(u)}
                            >
                              {u.is_active ? 'Disable' : 'Enable'}
                            </button>
                          )}
                          {u.is_active && !isSelf(u) && (
                            <button className="btn btn-xs btn-danger-outline" onClick={() => handleDelete(u)}>Delete</button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr><td colSpan={6} className="admin-empty-cell">No users found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Reset password modal */}
      {resetId && (
        <div className="modal-overlay" onClick={() => setResetId(null)}>
          <div className="modal-content modal-narrow" onClick={(e) => e.stopPropagation()}>
            <h4 className="modal-title">Reset Password</h4>
            <p className="section-desc">
              User: <strong>{users.find((u) => u.id === resetId)?.username}</strong>
            </p>
            <div className="form-group">
              <label>New Password</label>
              <input
                type="password"
                placeholder="Min 12 chars, mixed case, digit, special"
                value={resetPw}
                onChange={(e) => setResetPw(e.target.value)}
                minLength={12}
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-sm btn-outline" onClick={() => setResetId(null)}>Cancel</button>
              <button className="btn btn-sm" onClick={handleResetPw} disabled={resetting || resetPw.length < 12}>
                {resetting ? 'Resetting…' : 'Reset Password'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
