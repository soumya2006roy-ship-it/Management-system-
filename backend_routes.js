const express = require('express');
const { ApiError } = require('./backend_services');
const crypto = require('crypto');
const { logError } = require('./logger');

const SESSION_COOKIE = 'orion_session';
const CSRF_COOKIE = 'orion_csrf';
const COOKIE_TTL_SECONDS = 24 * 60 * 60;
function cookies(req) {
    return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
        const index = part.indexOf('=');
        return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }));
}
function cookieOptions(name, value, { httpOnly = false, maxAge = COOKIE_TTL_SECONDS } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${maxAge}`, 'SameSite=Lax'];
    if (httpOnly) parts.push('HttpOnly');
    if (process.env.NODE_ENV === 'production') parts.push('Secure');
    return parts.join('; ');
}
function csrfMac(nonce) {
    return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(nonce).digest('hex');
}
function safeEqual(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function handleError(res, error) {
    if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
    }
    logError('api_request_failed', error, { status: 500 });
    res.status(500).json({ error: 'Internal server error' });
}

function registerApiRoutes(app, services) {
    const router = express.Router();
    const isMock = typeof app.listen !== 'function' && typeof app.handle !== 'function';

    const register = (method, path, ...handlers) => {
        router[method](path, ...handlers);
        if (isMock && typeof app[method] === 'function') {
            app[method](`/api${path}`, ...handlers);
            app[method](`/api/v1${path}`, ...handlers);
        }
    };

    router.use((req, res, next) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
        const origin = req.headers.origin;
        const referer = req.headers.referer;
        let sourceOrigin = origin;
        if (!sourceOrigin && referer) {
            try { sourceOrigin = new URL(referer).origin; } catch (_error) { sourceOrigin = ''; }
        }
        let sameOrigin = false;
        try {
            const parsedOrigin = sourceOrigin ? new URL(sourceOrigin) : null;
            const originAllowlist = String(process.env.CORS_ORIGINS || '').split(',').map((entry) => entry.trim()).filter(Boolean);
            const localDevelopmentOrigin = process.env.NODE_ENV !== 'production' && Boolean(parsedOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(parsedOrigin.origin));
            sameOrigin = Boolean(parsedOrigin && (
                parsedOrigin.host === req.headers.host ||
                originAllowlist.includes(parsedOrigin.origin) ||
                localDevelopmentOrigin
            ));
        } catch (_error) {}
        const csrfCookie = cookies(req)[CSRF_COOKIE];
        const csrfHeader = req.headers['x-csrf-token'];
        const [nonce, mac, extra] = String(csrfCookie || '').split('.');
        if (!sameOrigin || req.headers['x-orion-request'] !== '1' || !csrfCookie || extra || !nonce || !mac || !safeEqual(csrfCookie, csrfHeader) || !safeEqual(mac, csrfMac(nonce))) {
            res.status(403).json({ error: 'Request verification failed. Refresh the page and try again.' });
            return;
        }
        next();
    });

    const rateLimit = (name, limit, windowMs) => async (req, res, next) => {
        try {
            // Do not trust forwarded headers unless an explicit proxy deployment is configured on the app.
            const trustProxy = req.app ? Boolean(req.app.get('trust proxy')) : false;
            const source = (trustProxy ? req.ip : null) || req.socket?.remoteAddress || 'unknown';
            const key = crypto.createHash('sha256').update(`${name}:${source}`).digest('hex');
            const result = await services.consumeRateLimit(key, limit, windowMs);
            if (!result.allowed) {
                res.setHeader('Retry-After', String(result.retryAfter));
                res.status(429).json({ error: 'Too many attempts. Please try again shortly.' });
                return;
            }
            next();
        } catch (error) { handleError(res, error); }
    };

    const authenticate = async (req, res, next) => {
        try {
            const token = cookies(req)[SESSION_COOKIE];
            if (!token) {
                res.status(401).json({ error: 'Missing or invalid session cookie' });
                return;
            }
            const userId = await services.getUserIdByToken(token);
            if (!userId) {
                res.status(401).json({ error: 'Session expired or invalid' });
                return;
            }
            const user = await services.getPublicUserById(userId);
            if (!user) {
                res.status(401).json({ error: 'User not found' });
                return;
            }
            req.user = user;
            next();
        } catch (error) {
            handleError(res, error);
        }
    };

    register('get', '/health', async (_req, res) => {
        try {
            await services.checkDatabase();
            res.json({ ok: true, status: 'ready' });
        } catch (error) {
            logError('readiness_check_failed', error);
            res.status(503).json({ ok: false, status: 'unavailable' });
        }
    });

    register('get', '/config', (_req, res) => {
        const enableDemo = services && services.config
            ? Boolean(services.config.enableDemoAccounts)
            : (process.env.ENABLE_DEMO_ACCOUNTS !== undefined
                ? (process.env.ENABLE_DEMO_ACCOUNTS === 'true' || process.env.ENABLE_DEMO_ACCOUNTS === '1')
                : process.env.NODE_ENV !== 'production');
        res.json({ enableDemoAccounts: enableDemo });
    });

    register('get', '/csrf', (_req, res) => {
        const nonce = crypto.randomBytes(24).toString('base64url');
        const token = `${nonce}.${csrfMac(nonce)}`;
        const enableDemo = services && services.config
            ? Boolean(services.config.enableDemoAccounts)
            : (process.env.ENABLE_DEMO_ACCOUNTS !== undefined
                ? (process.env.ENABLE_DEMO_ACCOUNTS === 'true' || process.env.ENABLE_DEMO_ACCOUNTS === '1')
                : process.env.NODE_ENV !== 'production');
        res.setHeader('Set-Cookie', cookieOptions(CSRF_COOKIE, token));
        res.json({ token, enableDemoAccounts: enableDemo });
    });

    register('get', '/session', authenticate, (req, res) => {
        res.json(req.user);
    });

    register('post', '/register', rateLimit('register', 8, 60 * 60 * 1000), async (req, res) => {
        try {
            const result = await services.registerUser(req.body || {});
            const { token, ...user } = result;
            res.setHeader('Set-Cookie', cookieOptions(SESSION_COOKIE, token, { httpOnly: true }));
            res.status(201).json(user);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/login', rateLimit('login', 12, 15 * 60 * 1000), async (req, res) => {
        try {
            const user = await services.login(req.body || {});
            if (!user) {
                res.status(401).json({ error: 'Invalid credentials' });
                return;
            }
            const { token, ...publicUser } = user;
            res.setHeader('Set-Cookie', cookieOptions(SESSION_COOKIE, token, { httpOnly: true }));
            res.json(publicUser);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/logout', async (req, res) => {
        try {
            const token = cookies(req)[SESSION_COOKIE];
            if (token) await services.destroySession(token);
            res.setHeader('Set-Cookie', cookieOptions(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0 }));
            res.json({ success: true });
        } catch (error) { handleError(res, error); }
    });

    register('post', '/password-reset/request', rateLimit('password-reset-ip', 8, 60 * 60 * 1000), async (req, res) => {
        try {
            res.json(await services.requestPasswordReset(req.body || {}));
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/password-reset/confirm', rateLimit('password-reset-confirm', 8, 60 * 60 * 1000), async (req, res) => {
        try {
            const result = await services.resetPassword(req.body || {});
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/dashboard/:userId', authenticate, async (req, res) => {
        try {
            if (Number(req.user.id) !== Number(req.params.userId)) {
                res.status(403).json({ error: "Access denied: Cannot view another user's dashboard" });
                return;
            }
            const data = await services.getDashboard(req.params.userId);
            res.json(data);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/tasks', authenticate, async (req, res) => {
        try {
            const result = await services.getTasksPaginated(req.user.id, req.query);
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/projects', authenticate, async (req, res) => {
        try {
            const result = await services.getProjectsPaginated(req.user.id, req.query);
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/updates', authenticate, async (req, res) => {
        try {
            const result = await services.getUpdatesPaginated(req.user.id, req.query);
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/members', authenticate, async (req, res) => {
        try {
            const result = await services.getMembersPaginated(req.user.id, req.query);
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/projects', authenticate, async (req, res) => {
        try {
            if (req.user.role !== 'manager') {
                res.status(403).json({ error: 'Access denied: Only managers can launch projects' });
                return;
            }
            const result = await services.createProject({ ...req.body, creatorId: req.user.id });
            res.status(201).json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/tasks', authenticate, async (req, res) => {
        try {
            if (req.user.role !== 'manager') {
                res.status(403).json({ error: 'Access denied: Only managers can assign tasks' });
                return;
            }
            const createdBy = req.body && req.body.createdBy != null ? req.body.createdBy : req.user.id;
            if (Number(req.user.id) !== Number(createdBy)) {
                res.status(403).json({ error: 'Access denied: Creator mismatch' });
                return;
            }
            const result = await services.createTask({ ...req.body, createdBy: req.user.id });
            res.status(201).json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('patch', '/tasks/:id', authenticate, async (req, res) => {
        try {
            const taskId = Number(req.params.id);
            if (isNaN(taskId) || taskId <= 0) {
                res.status(400).json({ error: 'Invalid task ID' });
                return;
            }
            const task = await services.updateTask({ ...req.body, taskId, requesterId: req.user.id });
            res.json({ success: true, task });
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/tasks/:id/reassign', authenticate, async (req, res) => {
        try {
            const taskId = Number(req.params.id);
            if (isNaN(taskId) || taskId <= 0) {
                res.status(400).json({ error: 'Invalid task ID' });
                return;
            }
            const newAssigneeId = req.body && req.body.newAssigneeId;
            const task = await services.reassignTask({ taskId, newAssigneeId, requesterId: req.user.id });
            res.json({ success: true, task });
        } catch (error) {
            handleError(res, error);
        }
    });

    register('delete', '/tasks/:id', authenticate, async (req, res) => {
        try {
            const taskId = Number(req.params.id);
            if (isNaN(taskId) || taskId <= 0) {
                res.status(400).json({ error: 'Invalid task ID' });
                return;
            }
            const result = await services.deleteTask({ taskId, requesterId: req.user.id });
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/tasks/update', (_req, res) => {
        res.status(410).json({ error: 'Endpoint deprecated. Use PATCH /api/v1/tasks/:id instead.' });
    });

    register('get', '/institutions', authenticate, async (req, res) => {
        try {
            if (req.query.page || req.query.limit) {
                const result = await services.getInstitutionsPaginated(req.query);
                res.json(result);
            } else {
                const rows = await services.getInstitutions(req.query.search || '');
                res.json(rows);
            }
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/institutions', authenticate, async (req, res) => {
        try {
            res.setHeader('X-Deprecated', 'POST /institutions is deprecated. Use POST /organizations/applications for verified onboarding.');
            if (req.user.role !== 'manager' && req.user.role !== 'exec') {
                res.status(403).json({ error: 'Access denied: Only managers or executives can register institutions' });
                return;
            }
            const result = await services.addInstitution({ ...(req.body || {}), creatorId: req.user.id });
            res.status(201).json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/organizations/applications', authenticate, rateLimit('organization-application', 3, 60 * 60 * 1000), async (req, res) => {
        try { res.status(201).json(await services.submitOrganizationApplication(req.user.id, req.body || {})); }
        catch (error) { handleError(res, error); }
    });

    register('get', '/organizations/applications/mine', authenticate, async (req, res) => {
        try { res.json(await services.getMyOrganizationApplication(req.user.id)); }
        catch (error) { handleError(res, error); }
    });

    register('get', '/platform/organization-applications', authenticate, async (req, res) => {
        try { res.json(await services.getOrganizationApplications(req.user.id)); }
        catch (error) { handleError(res, error); }
    });

    register('post', '/platform/organization-applications/:id/review', authenticate, async (req, res) => {
        try { res.json(await services.reviewOrganizationApplication(req.params.id, req.user.id, req.body && req.body.action, req.body && req.body.reviewComment)); }
        catch (error) { handleError(res, error); }
    });

    register('get', '/platform/admins', authenticate, async (req, res) => {
        try { res.json(await services.getPlatformAdmins(req.user.id)); }
        catch (error) { handleError(res, error); }
    });

    register('post', '/platform/admins', authenticate, async (req, res) => {
        try { res.status(201).json(await services.createPlatformAdmin(req.user.id, req.body || {})); }
        catch (error) { handleError(res, error); }
    });

    register('post', '/organizations/invites', authenticate, async (req, res) => {
        try { res.status(201).json(await services.createOrganizationInvite(req.user.id, req.body || {})); }
        catch (error) { handleError(res, error); }
    });

    register('get', '/organizations/invites', authenticate, async (req, res) => {
        try { res.json(await services.getOrganizationInvites(req.user.id)); }
        catch (error) { handleError(res, error); }
    });

    register('post', '/organizations/invites/:id/revoke', authenticate, async (req, res) => {
        try { res.json(await services.revokeOrganizationInvite(req.user.id, req.params.id)); }
        catch (error) { handleError(res, error); }
    });

    register('post', '/organizations/redeem-invite', authenticate, rateLimit('invite-redemption', 8, 15 * 60 * 1000), async (req, res) => {
        try { res.json(await services.redeemOrganizationInvite(req.user.id, req.body && req.body.code)); }
        catch (error) { handleError(res, error); }
    });

    register('post', '/tasks/:id/subtasks', authenticate, async (req, res) => {
        try { res.status(201).json(await services.createSubtask(req.user.id, { ...(req.body || {}), parentTaskId: req.params.id })); }
        catch (error) { handleError(res, error); }
    });

    register('get', '/tasks/:id/subtasks', authenticate, async (req, res) => {
        try { res.json(await services.getSubtasks(req.params.id, req.user.id)); }
        catch (error) { handleError(res, error); }
    });

    register('post', '/subtasks/:id/submit', authenticate, async (req, res) => {
        try { res.json(await services.submitSubtask(req.params.id, req.user.id, req.body || {})); }
        catch (error) { handleError(res, error); }
    });

    register('post', '/subtasks/:id/review', authenticate, async (req, res) => {
        try { res.json(await services.reviewSubtask(req.params.id, req.user.id, req.body && req.body.action, req.body && req.body.reviewComment)); }
        catch (error) { handleError(res, error); }
    });

    register('post', '/users/:id/organization', authenticate, async (req, res) => {
        try {
            if (Number(req.user.id) !== Number(req.params.id)) {
                res.status(403).json({ error: 'Access denied: Cannot join organization for another user' });
                return;
            }
            const result = await services.joinOrganization({ ...(req.body || {}), userId: req.params.id });
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/users/:id/organization', authenticate, async (req, res) => {
        try {
            if (Number(req.user.id) !== Number(req.params.id)) {
                res.status(403).json({ error: "Access denied: Cannot view another user's organization" });
                return;
            }
            const result = await services.getWorkerOrganization(req.params.id);
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/reports', authenticate, async (req, res) => {
        try {
            const submittedBy = req.body && req.body.submittedBy != null ? req.body.submittedBy : req.user.id;
            if (Number(req.user.id) !== Number(submittedBy)) {
                res.status(403).json({ error: 'Access denied: Cannot submit report as another user' });
                return;
            }
            const result = await services.submitReport({ ...req.body, submittedBy: req.user.id });
            res.status(201).json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/reports/pending', authenticate, async (req, res) => {
        try {
            const reviewerId = req.query.reviewerId != null ? req.query.reviewerId : req.user.id;
            if (Number(req.user.id) !== Number(reviewerId)) {
                res.status(403).json({ error: "Access denied: Cannot view another user's pending review queue" });
                return;
            }
            const rows = await services.getPendingReports(req.user.id);
            res.json(rows);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/reports/:id/review', authenticate, async (req, res) => {
        try {
            const reviewerId = req.body && req.body.reviewerId != null ? req.body.reviewerId : req.user.id;
            if (Number(req.user.id) !== Number(reviewerId)) {
                res.status(403).json({ error: 'Access denied: Cannot review report as another user' });
                return;
            }
            const result = await services.reviewReport(req.params.id, { ...req.body, reviewerId: req.user.id });
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/tasks/:id/reports', authenticate, async (req, res) => {
        try {
            const requesterId = req.query.requesterId != null ? req.query.requesterId : req.user.id;
            if (Number(req.user.id) !== Number(requesterId)) {
                res.status(403).json({ error: 'Access denied: Cannot request reports history as another user' });
                return;
            }
            const rows = await services.getTaskReports(req.params.id, req.user.id);
            res.json(rows);
        } catch (error) {
            handleError(res, error);
        }
    });

    // Government Schemes Endpoints
    register('get', '/schemes', authenticate, async (req, res) => {
        try {
            const schemes = await services.getGovernmentSchemes(req.query);
            res.json(schemes);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/projects/:id/schemes', authenticate, async (req, res) => {
        try {
            const projectId = Number(req.params.id);
            const data = await services.getSchemesForProject(req.user.id, projectId);
            res.json(data);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/projects/:id/schemes/:schemeId/apply', authenticate, async (req, res) => {
        try {
            const projectId = Number(req.params.id);
            const schemeId = Number(req.params.schemeId);
            const result = await services.applyForScheme(req.user.id, projectId, schemeId);
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/projects/:id/schemes/:schemeId/readiness', authenticate, async (req, res) => {
        try {
            const projectId = Number(req.params.id);
            const schemeId = Number(req.params.schemeId);
            const { criterionKey, status } = req.body || {};
            const result = await services.updateSchemeReadiness(req.user.id, projectId, schemeId, criterionKey, status);
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/schemes/ingest', authenticate, async (req, res) => {
        try {
            if (req.user.role !== 'admin' && req.user.role !== 'exec') {
                return res.status(403).json({ error: 'Only administrators or executives can ingest scheme feeds' });
            }
            const { items } = req.body || {};
            const result = await services.ingestSchemesFromFeed(items);
            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('post', '/assistant', authenticate, rateLimit('assistant', 25, 60 * 1000), async (req, res) => {
        try {
            const { message, projectId, confirmedAction } = req.body || {};
            const isStream = req.query.stream === '1' || (req.headers.accept && req.headers.accept.includes('text/event-stream'));

            if (isStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                if (typeof res.flushHeaders === 'function') {
                    res.flushHeaders();
                }

                const ac = new AbortController();
                req.on('close', () => {
                    ac.abort();
                });

                try {
                    const result = await services.assistantChatStream(
                        req.user.id,
                        {
                            message,
                            projectId: projectId ? Number(projectId) : null,
                            confirmedAction
                        },
                        (chunkText) => {
                            if (!res.writableEnded) {
                                res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunkText })}\n\n`);
                                if (typeof res.flush === 'function') {
                                    res.flush();
                                }
                            }
                        },
                        ac.signal
                    );

                    if (!res.writableEnded) {
                        res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
                        res.end();
                    }
                    return;
                } catch (streamError) {
                    if (!res.writableEnded) {
                        res.write(`event: error\ndata: ${JSON.stringify({ error: streamError.message || 'Streaming failed', status: streamError.status || 500 })}\n\n`);
                        res.end();
                    }
                    return;
                }
            }

            const result = await services.assistantChat(req.user.id, {
                message,
                projectId: projectId ? Number(projectId) : null,
                confirmedAction
            });

            res.json(result);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/export/tasks/csv', authenticate, async (req, res) => {
        try {
            const dateStr = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="tasks_export_${dateStr}.csv"`);
            await services.exportTasksCsv(req.user.id, req.query, res);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/export/projects/csv', authenticate, async (req, res) => {
        try {
            const dateStr = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="projects_export_${dateStr}.csv"`);
            await services.exportProjectsCsv(req.user.id, req.query, res);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/export/members/csv', authenticate, async (req, res) => {
        try {
            const dateStr = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="members_export_${dateStr}.csv"`);
            await services.exportMembersCsv(req.user.id, req.query, res);
        } catch (error) {
            handleError(res, error);
        }
    });

    register('get', '/export/projects/:id/pdf', authenticate, async (req, res) => {
        try {
            const projectId = Number(req.params.id);
            if (!projectId || isNaN(projectId)) {
                res.status(400).json({ error: 'Invalid project ID' });
                return;
            }
            const dateStr = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="project_${projectId}_report_${dateStr}.pdf"`);
            await services.exportProjectPdf(req.user.id, projectId, res);
        } catch (error) {
            handleError(res, error);
        }
    });

    if (typeof app.use === 'function') {
        app.use('/api/v1', router);
        app.use('/api', router);
    }
    return router;
}

module.exports = { registerApiRoutes };
