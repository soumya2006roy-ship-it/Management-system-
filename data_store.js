const API_URL = (() => {
    if (typeof window !== 'undefined' && window.location) {
        if (window.location.port && window.location.port !== '3000' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
            return `http://${window.location.hostname}:3000/api`;
        }
    }
    return '/api';
})();

async function parseJsonSafe(res, fallbackMessage = 'Request failed') {
    let payload = null;
    try {
        payload = await res.json();
    } catch (_e) {
        // Non-JSON response
    }
    if (!res.ok) {
        const errorMsg = (payload && payload.error) ? payload.error : `${fallbackMessage} (Status ${res.status})`;
        const err = new Error(errorMsg);
        err.status = res.status;
        throw err;
    }
    return payload || {};
}

class DataStore {
    constructor() {
        this.csrfToken = null;
    }

    getHeaders() {
        return { 'Content-Type': 'application/json' };
    }

    async request(url, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        const headers = { ...this.getHeaders(), ...(options.headers || {}) };
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            if (!this.csrfToken) {
                const csrfResponse = await fetch(`${API_URL}/csrf`, { credentials: 'include' });
                const csrfData = await parseJsonSafe(csrfResponse, 'Unable to verify request');
                this.csrfToken = csrfData.token;
            }
            headers['X-CSRF-Token'] = this.csrfToken;
            headers['X-Orion-Request'] = '1';
        }
        return fetch(url, { ...options, method, headers, credentials: 'include' });
    }

    async login(username, password) {
        try {
            const res = await this.request(`${API_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            if (!res.ok) {
                return null;
            }
            const data = await res.json();
            return data;
        } catch (e) {
            console.error('Login error:', e);
            return null;
        }
    }

    async getSession() {
        try {
            const res = await this.request(`${API_URL}/session`);
            if (!res.ok) return null;
            return await res.json();
        } catch (error) {
            console.error('Session restore failed:', error);
            return null;
        }
    }

    async logout() {
        try {
            await this.request(`${API_URL}/logout`, { method: 'POST', headers: this.getHeaders() });
        } catch (_e) {
        } finally {
            this.csrfToken = null;
        }
    }

    async register(email, password, role, name) {
        const res = await this.request(`${API_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: email, email, password, role, name })
        });
        const data = await parseJsonSafe(res, 'Registration failed');
        return data;
    }

    async requestPasswordReset(email) {
        const res = await this.request(`${API_URL}/password-reset/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        return parseJsonSafe(res, 'Unable to request password reset');
    }

    async confirmPasswordReset(token, newPassword) {
        const res = await this.request(`${API_URL}/password-reset/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, newPassword })
        });
        await parseJsonSafe(res, 'Password reset failed');
        return true;
    }

    async getDashboardData(user) {
        const empty = {
            currentUser: user,
            projects: [],
            updates: [],
            myTasks: [],
            allTasks: [],
            workers: [],
            pendingReports: []
        };
        try {
            const res = await this.request(`${API_URL}/dashboard/${user.id}`, {
                headers: this.getHeaders()
            });
            if (!res.ok) {
                if (res.status === 401) {
                    return { ...empty, unauthorized: true };
                }
                if (res.status === 403) return { ...empty, accessDenied: true };
                return empty;
            }
            const data = await res.json();
            return {
                ...empty,
                ...data,
                projects: data.projects || [],
                updates: data.updates || [],
                myTasks: data.myTasks || [],
                allTasks: data.allTasks || []
            };
        } catch (e) {
            console.error('getDashboardData error:', e);
            return empty;
        }
    }

    async updateTask(taskId, updateData) {
        const payload = typeof updateData === 'object' && updateData !== null
            ? updateData
            : { progress: updateData };
        const res = await this.request(`${API_URL}/tasks/${encodeURIComponent(taskId)}`, {
            method: 'PATCH',
            headers: this.getHeaders(),
            body: JSON.stringify(payload)
        });
        return await parseJsonSafe(res, 'Failed to update task');
    }

    async reassignTask(taskId, newAssigneeId) {
        const res = await this.request(`${API_URL}/tasks/${encodeURIComponent(taskId)}/reassign`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ newAssigneeId })
        });
        return await parseJsonSafe(res, 'Failed to reassign task');
    }

    async deleteTask(taskId) {
        const res = await this.request(`${API_URL}/tasks/${encodeURIComponent(taskId)}`, {
            method: 'DELETE',
            headers: this.getHeaders()
        });
        return await parseJsonSafe(res, 'Failed to delete task');
    }

    async submitReport(taskId, submittedBy, proposedProgress, reportText) {
        const res = await this.request(`${API_URL}/reports`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ taskId, submittedBy, proposedProgress, reportText })
        });
        return await parseJsonSafe(res, 'Failed to submit report');
    }

    async getPendingReports(reviewerId) {
        const res = await this.request(`${API_URL}/reports/pending?reviewerId=${encodeURIComponent(reviewerId)}`, {
            headers: this.getHeaders()
        });
        return await parseJsonSafe(res, 'Failed to load pending reports');
    }

    async reviewReport(reportId, reviewerId, action, reviewComment) {
        const res = await this.request(`${API_URL}/reports/${reportId}/review`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({ reviewerId, action, reviewComment })
        });
        return await parseJsonSafe(res, 'Failed to review report');
    }

    async getTaskReports(taskId, requesterId) {
        const res = await this.request(
            `${API_URL}/tasks/${encodeURIComponent(taskId)}/reports?requesterId=${encodeURIComponent(requesterId)}`,
            {
                headers: this.getHeaders()
            }
        );
        return await parseJsonSafe(res, 'Failed to load task reports');
    }

    async createTask(title, projectId, assignedTo, deadline, createdBy) {
        try {
            const res = await this.request(`${API_URL}/tasks`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({ title, projectId, assignedTo, deadline, createdBy })
            });
            return res.ok;
        } catch (e) {
            console.error('createTask error:', e);
            return false;
        }
    }

    async createProject(name) {
        try {
            const res = await this.request(`${API_URL}/projects`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({ name })
            });
            return res.ok;
        } catch (e) {
            console.error('createProject error:', e);
            return false;
        }
    }

    async getTasks(params = {}) {
        try {
            const q = new URLSearchParams();
            if (params.limit) q.set('limit', params.limit);
            if (params.cursor) q.set('cursor', params.cursor);
            if (params.sort) q.set('sort', params.sort);
            if (params.status) q.set('status', params.status);
            if (params.projectId) q.set('projectId', params.projectId);
            if (params.assignedTo) q.set('assignedTo', params.assignedTo);
            if (params.search) q.set('search', params.search);

            const res = await this.request(`${API_URL}/tasks?${q.toString()}`, {
                headers: this.getHeaders()
            });
            if (!res.ok) return { data: [], pageInfo: { hasMore: false } };
            return await res.json();
        } catch (e) {
            console.error('getTasks error:', e);
            return { data: [], pageInfo: { hasMore: false } };
        }
    }

    async getProjects(params = {}) {
        try {
            const q = new URLSearchParams();
            if (params.limit) q.set('limit', params.limit);
            if (params.page) q.set('page', params.page);
            if (params.search) q.set('search', params.search);
            if (params.status) q.set('status', params.status);

            const res = await this.request(`${API_URL}/projects?${q.toString()}`, {
                headers: this.getHeaders()
            });
            if (!res.ok) return { data: [], pageInfo: { hasMore: false } };
            return await res.json();
        } catch (e) {
            console.error('getProjects error:', e);
            return { data: [], pageInfo: { hasMore: false } };
        }
    }

    async getUpdates(params = {}) {
        try {
            const q = new URLSearchParams();
            if (params.limit) q.set('limit', params.limit);
            if (params.cursor) q.set('cursor', params.cursor);

            const res = await this.request(`${API_URL}/updates?${q.toString()}`, {
                headers: this.getHeaders()
            });
            if (!res.ok) return { data: [], pageInfo: { hasMore: false } };
            return await res.json();
        } catch (e) {
            console.error('getUpdates error:', e);
            return { data: [], pageInfo: { hasMore: false } };
        }
    }

    async getMembers(params = {}) {
        try {
            const q = new URLSearchParams();
            if (params.limit) q.set('limit', params.limit);
            if (params.page) q.set('page', params.page);
            if (params.search) q.set('search', params.search);

            const res = await this.request(`${API_URL}/members?${q.toString()}`, {
                headers: this.getHeaders()
            });
            if (!res.ok) return { data: [], pageInfo: { hasMore: false } };
            return await res.json();
        } catch (e) {
            console.error('getMembers error:', e);
            return { data: [], pageInfo: { hasMore: false } };
        }
    }

    async getInstitutions(queryOrOptions = '') {
        try {
            const q = new URLSearchParams();
            if (typeof queryOrOptions === 'object' && queryOrOptions !== null) {
                if (queryOrOptions.search) q.set('search', queryOrOptions.search);
                if (queryOrOptions.page) q.set('page', queryOrOptions.page);
                if (queryOrOptions.limit) q.set('limit', queryOrOptions.limit);
            } else if (queryOrOptions) {
                q.set('search', queryOrOptions);
            }

            const res = await this.request(`${API_URL}/institutions?${q.toString()}`, {
                headers: this.getHeaders()
            });
            if (!res.ok) {
                return (typeof queryOrOptions === 'object' && queryOrOptions.page) ? { data: [], pageInfo: { hasMore: false } } : [];
            }
            return await res.json();
        } catch (e) {
            console.error('getInstitutions error:', e);
            return (typeof queryOrOptions === 'object' && queryOrOptions.page) ? { data: [], pageInfo: { hasMore: false } } : [];
        }
    }

    async addInstitution(name, type, contact) {
        const payload = typeof name === 'object' && name !== null ? name : { name, type, contact };
        const res = await this.request(`${API_URL}/institutions`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(payload)
        });
        return await parseJsonSafe(res, 'Failed to add institution');
    }

    async joinOrganization(userId, payload) {
        const body = typeof payload === 'object' && payload !== null ? payload : { institutionId: payload };
        const res = await this.request(`${API_URL}/users/${userId}/organization`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(body)
        });
        return await parseJsonSafe(res, 'Failed to join organization');
    }

    async applyForOrganization(application) {
        const res = await this.request(`${API_URL}/organizations/applications`, { method: 'POST', headers: this.getHeaders(), body: JSON.stringify(application) });
        return parseJsonSafe(res, 'Could not submit organization application');
    }

    async getMyOrganizationApplication() {
        const res = await this.request(`${API_URL}/organizations/applications/mine`, { headers: this.getHeaders() });
        const application = await parseJsonSafe(res, 'Could not load application status');
        return application && application.id ? application : null;
    }

    async getOrganizationApplications() {
        const res = await this.request(`${API_URL}/platform/organization-applications`, { headers: this.getHeaders() });
        return parseJsonSafe(res, 'Could not load applications');
    }

    async reviewOrganizationApplication(id, action, reviewComment = '') {
        const res = await this.request(`${API_URL}/platform/organization-applications/${encodeURIComponent(id)}/review`, { method: 'POST', headers: this.getHeaders(), body: JSON.stringify({ action, reviewComment }) });
        return parseJsonSafe(res, 'Could not review application');
    }

    async getPlatformAdmins() {
        const res = await this.request(`${API_URL}/platform/admins`, { headers: this.getHeaders() });
        return parseJsonSafe(res, 'Could not load website administrators');
    }

    async createPlatformAdmin(admin) {
        const res = await this.request(`${API_URL}/platform/admins`, { method: 'POST', headers: this.getHeaders(), body: JSON.stringify(admin) });
        return parseJsonSafe(res, 'Could not create website administrator');
    }

    async createOrganizationInvite(maxUses, expiresInDays) {
        const res = await this.request(`${API_URL}/organizations/invites`, { method: 'POST', headers: this.getHeaders(), body: JSON.stringify({ maxUses, expiresInDays }) });
        return parseJsonSafe(res, 'Could not create invite');
    }

    async getOrganizationInvites() {
        const res = await this.request(`${API_URL}/organizations/invites`, { headers: this.getHeaders() });
        return parseJsonSafe(res, 'Could not load organization invites');
    }

    async revokeOrganizationInvite(id) {
        const res = await this.request(`${API_URL}/organizations/invites/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: this.getHeaders() });
        return parseJsonSafe(res, 'Could not revoke invite');
    }

    async redeemOrganizationInvite(code) {
        const res = await this.request(`${API_URL}/organizations/redeem-invite`, { method: 'POST', headers: this.getHeaders(), body: JSON.stringify({ code }) });
        return parseJsonSafe(res, 'Could not redeem invite');
    }

    async getSubtasks(taskId) {
        const res = await this.request(`${API_URL}/tasks/${encodeURIComponent(taskId)}/subtasks`, { headers: this.getHeaders() });
        return parseJsonSafe(res, 'Could not load subtasks');
    }

    async createSubtask(taskId, subtask) {
        const res = await this.request(`${API_URL}/tasks/${encodeURIComponent(taskId)}/subtasks`, { method: 'POST', headers: this.getHeaders(), body: JSON.stringify(subtask) });
        return parseJsonSafe(res, 'Could not create subtask');
    }

    async submitSubtask(id, submissionText, evidenceUrl = '') {
        const res = await this.request(`${API_URL}/subtasks/${encodeURIComponent(id)}/submit`, { method: 'POST', headers: this.getHeaders(), body: JSON.stringify({ submissionText, evidenceUrl }) });
        return parseJsonSafe(res, 'Could not submit subtask');
    }

    async reviewSubtask(id, action, reviewComment = '') {
        const res = await this.request(`${API_URL}/subtasks/${encodeURIComponent(id)}/review`, { method: 'POST', headers: this.getHeaders(), body: JSON.stringify({ action, reviewComment }) });
        return parseJsonSafe(res, 'Could not review subtask');
    }

    async getWorkerOrganization(userId) {
        try {
            const res = await this.request(`${API_URL}/users/${userId}/organization`, {
                headers: this.getHeaders()
            });
            if (!res.ok) return { organization: null };
            return await res.json();
        } catch (_e) {
            return { organization: null };
        }
    }

    async assistantChat({ message, projectId, confirmedAction } = {}) {
        const res = await this.request(`${API_URL}/assistant`, {
            method: 'POST',
            body: JSON.stringify({ message, projectId, confirmedAction })
        });
        return await parseJsonSafe(res, 'AI Assistant request failed');
    }

}

export const store = new DataStore();
