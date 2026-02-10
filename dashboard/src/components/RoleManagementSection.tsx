import { useState, useEffect, useCallback } from 'react';
import {
  type RoleInfo,
  type PermissionInfo,
  fetchRoles,
  fetchAllPermissions,
  createRole,
  updateRole,
  deleteRole,
} from '../api';

interface Props {
  onAuthError: () => void;
}

export function RoleManagementSection({ onAuthError }: Props) {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [allPerms, setAllPerms] = useState<PermissionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Selected role for editing
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [editPerms, setEditPerms] = useState<Set<string>>(new Set());
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // New role modal
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPerms, setNewPerms] = useState<Set<string>>(new Set());

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [rolesData, permsData] = await Promise.all([fetchRoles(), fetchAllPermissions()]);
      setRoles(rolesData);
      setAllPerms(permsData);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) onAuthError();
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { load(); }, [load]);

  // Group permissions by category
  const permsByCategory = allPerms.reduce<Record<string, PermissionInfo[]>>((acc, p) => {
    (acc[p.category] = acc[p.category] ?? []).push(p);
    return acc;
  }, {});

  const categoryOrder = ['Dashboard', 'Events', 'Systems', 'AI', 'Notifications', 'Database', 'Privacy', 'Administration', 'Audit', 'Ingest'];

  const sortedCategories = Object.keys(permsByCategory).sort(
    (a, b) => (categoryOrder.indexOf(a) === -1 ? 99 : categoryOrder.indexOf(a)) - (categoryOrder.indexOf(b) === -1 ? 99 : categoryOrder.indexOf(b))
  );

  // Select a role for editing
  const selectRole = (name: string) => {
    const role = roles.find((r) => r.name === name);
    if (!role) return;
    setSelectedRole(name);
    setEditPerms(new Set(role.permissions));
    setEditDisplayName(role.display_name);
    setEditDescription(role.description);
    setDirty(false);
    setError('');
    setSuccess('');
  };

  // Toggle a permission in the edit set
  const togglePerm = (perm: string, set: Set<string>, setter: (s: Set<string>) => void, markDirty = false) => {
    const next = new Set(set);
    if (next.has(perm)) next.delete(perm); else next.add(perm);
    setter(next);
    if (markDirty) setDirty(true);
  };

  // Toggle an entire category
  const toggleCategory = (category: string, set: Set<string>, setter: (s: Set<string>) => void, markDirty = false) => {
    const catPerms = permsByCategory[category] ?? [];
    const allChecked = catPerms.every((p) => set.has(p.permission));
    const next = new Set(set);
    catPerms.forEach((p) => {
      if (allChecked) next.delete(p.permission); else next.add(p.permission);
    });
    setter(next);
    if (markDirty) setDirty(true);
  };

  // Save edited role
  const handleSave = async () => {
    if (!selectedRole) return;
    try {
      setSaving(true);
      setError('');
      await updateRole(selectedRole, {
        display_name: editDisplayName,
        description: editDescription,
        permissions: Array.from(editPerms),
      });
      setSuccess('Role updated successfully.');
      setDirty(false);
      await load();
      // Re-sync edit form from fresh data
      const freshRoles = await fetchRoles();
      const freshRole = freshRoles.find((r) => r.name === selectedRole);
      if (freshRole) {
        setEditPerms(new Set(freshRole.permissions));
        setEditDisplayName(freshRole.display_name);
        setEditDescription(freshRole.description);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) onAuthError();
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  // Create new role
  const handleCreate = async () => {
    try {
      setSaving(true);
      setError('');
      await createRole({
        name: newName,
        display_name: newDisplayName,
        description: newDescription,
        permissions: Array.from(newPerms),
      });
      setShowCreate(false);
      setNewName('');
      setNewDisplayName('');
      setNewDescription('');
      setNewPerms(new Set());
      setSuccess('Role created successfully.');
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) onAuthError();
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  // Delete role
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setSaving(true);
      setError('');
      await deleteRole(deleteTarget);
      if (selectedRole === deleteTarget) setSelectedRole(null);
      setDeleteTarget(null);
      setSuccess('Role deleted.');
      await load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) onAuthError();
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const currentRole = roles.find((r) => r.name === selectedRole);

  // Permission grid renderer
  const renderPermGrid = (perms: Set<string>, setter: (s: Set<string>) => void, disabled?: boolean, markDirty = false) => (
    <div className="role-perm-grid">
      {sortedCategories.map((cat) => {
        const catPerms = permsByCategory[cat] ?? [];
        const checkedCount = catPerms.filter((p) => perms.has(p.permission)).length;
        const allChecked = checkedCount === catPerms.length;
        const someChecked = checkedCount > 0 && !allChecked;

        return (
          <div key={cat} className="role-perm-category">
            <div className="role-perm-category-header">
              <label className="role-perm-cat-toggle">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => { if (el) el.indeterminate = someChecked; }}
                  onChange={() => toggleCategory(cat, perms, setter, markDirty)}
                  disabled={disabled}
                />
                <span className="role-perm-cat-label">{cat}</span>
                <span className="role-perm-cat-count">{checkedCount}/{catPerms.length}</span>
              </label>
            </div>
            <div className="role-perm-list">
              {catPerms.map((p) => (
                <label key={p.permission} className="role-perm-item">
                  <input
                    type="checkbox"
                    checked={perms.has(p.permission)}
                    onChange={() => togglePerm(p.permission, perms, setter, markDirty)}
                    disabled={disabled}
                  />
                  <span className="role-perm-label">{p.label}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );

  if (loading) return <div className="admin-section"><p>Loading roles...</p></div>;

  return (
    <div className="admin-section">
      <h2 className="section-title">Roles &amp; Permissions</h2>
      <p className="section-subtitle">
        Configure roles and their granular permissions. System roles cannot be deleted but their permissions can be customized.
      </p>

      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')}>&times;</button>
        </div>
      )}
      {success && (
        <div className="success-msg" role="status">
          {success}
          <button className="error-dismiss" onClick={() => setSuccess('')}>&times;</button>
        </div>
      )}

      <div className="role-layout">
        {/* ── Left: Role list ── */}
        <div className="role-sidebar">
          <div className="role-sidebar-header">
            <h3>Roles</h3>
            <button className="btn btn-sm btn-primary" onClick={() => setShowCreate(true)}>+ New Role</button>
          </div>
          <div className="role-list">
            {roles.map((r) => (
              <button
                key={r.name}
                className={`role-list-item${selectedRole === r.name ? ' active' : ''}`}
                onClick={() => selectRole(r.name)}
              >
                <div className="role-list-item-name">{r.display_name}</div>
                <div className="role-list-item-meta">
                  {r.is_system && <span className="db-status-badge badge-ok">System</span>}
                  <span className="role-perm-cat-count">{r.permissions.length} permissions</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Right: Permission editor ── */}
        <div className="role-editor">
          {selectedRole && currentRole ? (
            <>
              <div className="role-editor-header">
                <div className="role-editor-title-row">
                  <h3>{currentRole.display_name}</h3>
                  {!currentRole.is_system && (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleteTarget(currentRole.name)}
                    >
                      Delete Role
                    </button>
                  )}
                </div>
                <div className="admin-form-panel" style={{ marginBottom: '1rem' }}>
                  <div className="form-group">
                    <label>Display Name</label>
                    <input
                      type="text"
                      value={editDisplayName}
                      onChange={(e) => { setEditDisplayName(e.target.value); setDirty(true); }}
                    />
                  </div>
                  <div className="form-group">
                    <label>Description</label>
                    <input
                      type="text"
                      value={editDescription}
                      onChange={(e) => { setEditDescription(e.target.value); setDirty(true); }}
                    />
                  </div>
                </div>
              </div>

              <h4 className="role-perm-heading">Permissions</h4>
              {renderPermGrid(editPerms, setEditPerms, false, true)}

              <div className="role-editor-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={!dirty || saving}
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                {dirty && (
                  <button className="btn btn-outline" onClick={() => selectRole(selectedRole)}>
                    Discard
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="role-editor-empty">
              <p>Select a role from the list to view and edit its permissions.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Create Role Modal ── */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-content modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Create New Role</h3>
            <div className="admin-form-panel">
              <div className="form-group">
                <label>Role Name (internal, lowercase)</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                  placeholder="e.g. security_analyst"
                />
              </div>
              <div className="form-group">
                <label>Display Name</label>
                <input
                  type="text"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  placeholder="e.g. Security Analyst"
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Optional description"
                />
              </div>
            </div>

            <h4 className="role-perm-heading" style={{ marginTop: '1rem' }}>Permissions</h4>
            {renderPermGrid(newPerms, setNewPerms)}

            <div className="modal-actions">
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={!newName || !newDisplayName || saving}
              >
                {saving ? 'Creating...' : 'Create Role'}
              </button>
              <button className="btn btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Modal ── */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal-content modal-narrow" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete Role</h3>
            <p>
              Are you sure you want to delete the role <strong>{roles.find((r) => r.name === deleteTarget)?.display_name}</strong>?
              This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn btn-danger" onClick={handleDelete} disabled={saving}>
                {saving ? 'Deleting...' : 'Delete'}
              </button>
              <button className="btn btn-outline" onClick={() => setDeleteTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
