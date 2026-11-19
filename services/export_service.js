'use strict';

const PDFDocument = require('pdfkit');

function escapeCsvCell(value) {
    if (value === null || value === undefined) return '';
    let str = String(value);
    if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
    }
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function formatCsvRow(values) {
    return values.map(escapeCsvCell).join(',') + '\r\n';
}

class ExportService {
    constructor(data, services) {
        this.data = data;
        this.services = services;
    }

    async exportTasksCsv(userId, options = {}, stream) {
        if (!userId) throw new this.services.ApiError(401, 'Unauthorized');
        const user = await this.services.getPublicUserById(userId);
        if (!user) throw new this.services.ApiError(401, 'User not found');
        const orgId = user.organizationId;
        if (!orgId) throw new this.services.ApiError(400, 'User does not belong to an organization');

        const params = [orgId];
        let sql = `
            SELECT t.id, t.title, t.description, t.status, t.priority, t.progress, t.deadline,
                   u.name AS assigneeName, p.name AS projectName
            FROM tasks t
            JOIN projects p ON p.id = t.projectId
            LEFT JOIN users u ON u.id = t.assignedTo
            WHERE p.organizationId = ?
        `;

        if (options.projectId) {
            sql += ' AND t.projectId = ?';
            params.push(options.projectId);
        }
        if (options.status) {
            sql += ' AND t.status = ?';
            params.push(options.status);
        }
        if (options.assignedTo) {
            sql += ' AND t.assignedTo = ?';
            params.push(options.assignedTo);
        }
        if (options.search) {
            sql += ' AND (t.title LIKE ? OR t.description LIKE ?)';
            params.push(`%${options.search}%`, `%${options.search}%`);
        }
        sql += ' ORDER BY t.id DESC';

        stream.write('\uFEFF'); // UTF-8 BOM
        stream.write(formatCsvRow(['Task ID', 'Title', 'Description', 'Status', 'Priority', 'Progress (%)', 'Assignee', 'Project', 'Deadline']));

        let offset = 0;
        const chunkSize = 500;
        while (true) {
            const chunk = await this.data.all(`${sql} LIMIT ? OFFSET ?`, [...params, chunkSize, offset]);
            if (!chunk.length) break;
            for (const t of chunk) {
                const deadlineFormatted = t.deadline
                    ? new Date(isNaN(Number(t.deadline)) ? t.deadline : Number(t.deadline)).toISOString().split('T')[0]
                    : '';
                const row = [
                    t.id,
                    t.title,
                    t.description || '',
                    t.status,
                    t.priority || 'normal',
                    t.progress || 0,
                    t.assigneeName || 'Unassigned',
                    t.projectName || '',
                    deadlineFormatted
                ];
                stream.write(formatCsvRow(row));
            }
            offset += chunk.length;
            if (chunk.length < chunkSize) break;
        }
        stream.end();
    }

    async exportProjectsCsv(userId, options = {}, stream) {
        if (!userId) throw new this.services.ApiError(401, 'Unauthorized');
        const user = await this.services.getPublicUserById(userId);
        if (!user) throw new this.services.ApiError(401, 'User not found');
        const orgId = user.organizationId;
        if (!orgId) throw new this.services.ApiError(400, 'User does not belong to an organization');

        const projects = await this.data.all(`
            SELECT p.id, p.name, p.status, p.progress
            FROM projects p
            WHERE p.organizationId = ?
            ORDER BY p.name COLLATE NOCASE
        `, [orgId]);

        const allTasks = await this.data.all(`
            SELECT t.projectId, t.status, t.deadline
            FROM tasks t
            JOIN projects p ON p.id = t.projectId
            WHERE p.organizationId = ?
        `, [orgId]);

        const tasksByProject = new Map();
        for (const t of allTasks) {
            if (!tasksByProject.has(t.projectId)) tasksByProject.set(t.projectId, []);
            tasksByProject.get(t.projectId).push(t);
        }

        stream.write('\uFEFF');
        stream.write(formatCsvRow(['Project ID', 'Name', 'Status', 'Progress (%)', 'Total Tasks', 'Completed Tasks', 'Overdue Tasks']));

        for (const p of projects) {
            const pTasks = tasksByProject.get(p.id) || [];
            const totalTasks = pTasks.length;
            const completedTasks = pTasks.filter(t => String(t.status).toLowerCase() === 'completed').length;
            const overdueTasks = pTasks.filter(t => String(t.status).toLowerCase() !== 'completed' && this.services.isDeadlineOverdue(t.deadline)).length;
            stream.write(formatCsvRow([
                p.id,
                p.name,
                p.status,
                p.progress || 0,
                totalTasks,
                completedTasks,
                overdueTasks
            ]));
        }
        stream.end();
    }

    async exportMembersCsv(userId, options = {}, stream) {
        if (!userId) throw new this.services.ApiError(401, 'Unauthorized');
        const user = await this.services.getPublicUserById(userId);
        if (!user) throw new this.services.ApiError(401, 'User not found');
        const orgId = user.organizationId;
        if (!orgId) throw new this.services.ApiError(400, 'User does not belong to an organization');

        const sql = `
            SELECT u.id, u.name, u.username, u.role
            FROM users u
            WHERE u.organizationId = ?
            ORDER BY u.name COLLATE NOCASE
        `;

        stream.write('\uFEFF');
        stream.write(formatCsvRow(['Member ID', 'Name', 'Username', 'Role']));

        const rows = await this.data.all(sql, [orgId]);
        for (const r of rows) {
            stream.write(formatCsvRow([r.id, r.name, r.username, r.role]));
        }
        stream.end();
    }

    async exportProjectPdf(userId, projectId, stream) {
        if (!userId) throw new this.services.ApiError(401, 'Unauthorized');
        const user = await this.services.getPublicUserById(userId);
        if (!user) throw new this.services.ApiError(401, 'User not found');
        const orgId = user.organizationId;
        if (!orgId) throw new this.services.ApiError(400, 'User does not belong to an organization');

        const project = await this.data.get('SELECT * FROM projects WHERE id = ? AND organizationId = ?', [projectId, orgId]);
        if (!project) throw new this.services.ApiError(404, 'Project not found');

        const tasks = await this.data.all(`
            SELECT t.id, t.title, t.status, t.priority, t.progress, t.deadline, u.name AS assigneeName
            FROM tasks t
            LEFT JOIN users u ON u.id = t.assignedTo
            WHERE t.projectId = ?
            ORDER BY t.id ASC
        `, [projectId]);

        const org = await this.data.get('SELECT name FROM institutions WHERE id = ?', [orgId]);
        const orgName = org ? org.name : 'Government Entity';

        const totalTasks = tasks.length;
        const completedTasks = tasks.filter(t => String(t.status).toLowerCase() === 'completed').length;
        const inProgressTasks = tasks.filter(t => ['in_progress', 'in progress'].includes(String(t.status).toLowerCase())).length;
        const overdueTasks = tasks.filter(t => String(t.status).toLowerCase() !== 'completed' && this.services.isDeadlineOverdue(t.deadline)).length;

        const doc = new PDFDocument({ margin: 40, size: 'A4' });
        doc.pipe(stream);

        // Header
        doc.fontSize(16).fillColor('#0f172a').text('ORION PROJECT STATUS REPORT', { align: 'center' });
        doc.moveDown(0.3);
        doc.fontSize(9).fillColor('#64748b').text(`Organization: ${orgName} | Generated: ${new Date().toLocaleDateString()} | Confidential - Official Use`, { align: 'center' });
        doc.moveDown(1.2);

        // Project Summary Box
        const boxTop = doc.y;
        doc.rect(40, boxTop, 515, 65).fillAndStroke('#f8fafc', '#cbd5e1');
        doc.fillColor('#0f172a').fontSize(13).text(`Project: ${project.name}`, 55, boxTop + 10);
        doc.fontSize(9.5).fillColor('#334155').text(
            `Status: ${project.status}    Progress: ${project.progress || 0}%    Total Tasks: ${totalTasks}    Completed: ${completedTasks}    In Progress: ${inProgressTasks}    Overdue: ${overdueTasks}`,
            55,
            boxTop + 32,
            { width: 485 }
        );

        doc.y = boxTop + 80;
        doc.moveDown(0.5);

        // Tasks Table Header
        doc.fontSize(11).fillColor('#0f172a').text('Detailed Tasks Breakdown', 40, doc.y);
        doc.moveDown(0.4);

        const tableTop = doc.y;
        doc.rect(40, tableTop, 515, 20).fill('#1e293b');
        doc.fillColor('#ffffff').fontSize(8.5);
        doc.text('ID', 48, tableTop + 5);
        doc.text('Title', 75, tableTop + 5);
        doc.text('Status', 245, tableTop + 5);
        doc.text('Priority', 320, tableTop + 5);
        doc.text('Assignee', 380, tableTop + 5);
        doc.text('Deadline', 475, tableTop + 5);

        let rowY = tableTop + 20;
        for (let i = 0; i < tasks.length; i++) {
            if (rowY > 750) {
                doc.addPage();
                rowY = 40;
            }
            const t = tasks[i];
            const bg = i % 2 === 0 ? '#f8fafc' : '#ffffff';
            doc.rect(40, rowY, 515, 18).fill(bg);
            doc.fillColor('#334155').fontSize(8);
            doc.text(String(t.id), 48, rowY + 4);
            doc.text(t.title, 75, rowY + 4, { width: 165, ellipsis: true });
            doc.text(t.status || 'todo', 245, rowY + 4);
            doc.text(t.priority || 'normal', 320, rowY + 4);
            doc.text(t.assigneeName || 'Unassigned', 380, rowY + 4, { width: 90, ellipsis: true });
            const deadlineFormatted = t.deadline
                ? new Date(isNaN(Number(t.deadline)) ? t.deadline : Number(t.deadline)).toISOString().split('T')[0]
                : '-';
            doc.text(deadlineFormatted, 475, rowY + 4);
            rowY += 18;
        }

        return new Promise((resolve, reject) => {
            stream.on('finish', resolve);
            stream.on('error', reject);
            doc.on('error', reject);
            doc.end();
        });
    }
}

module.exports = { ExportService, escapeCsvCell, formatCsvRow };
