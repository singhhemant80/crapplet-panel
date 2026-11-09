import fs from "fs";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { prisma, TicketPriority } from "../../db";
import { config } from "../../config";
import { nextSequence } from "../../lib/sequence";
import { badRequest } from "../../lib/http";
import { queueEmail } from "../email/mailer";

const ALLOWED = /\.(png|jpe?g|gif|webp|pdf|txt|log|zip|csv|docx?|xlsx?)$/i;
fs.mkdirSync(path.resolve(config.uploadDir, "tickets"), { recursive: true });

export const ticketUpload = multer({
  storage: multer.diskStorage({
    destination: path.resolve(config.uploadDir, "tickets"),
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString("hex")),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED.test(file.originalname)),
});

export type UploadedFile = Express.Multer.File;
const attachData = (files: UploadedFile[] = []) => files.map((f) => ({ filename: f.originalname.slice(0, 200), storedAs: f.filename, size: f.size, mime: f.mimetype }));

export async function openTicket(args: {
  userId: string;
  departmentId: string;
  subject: string;
  message: string;
  priority: TicketPriority;
  serviceId?: string | null;
  authorId: string;
  isStaff: boolean;
  files?: UploadedFile[];
}) {
  const dept = await prisma.ticketDepartment.findUnique({ where: { id: args.departmentId } });
  if (!dept) throw badRequest("Invalid department");
  if (args.serviceId) {
    const owns = await prisma.service.count({ where: { id: args.serviceId, userId: args.userId } });
    if (!owns) throw badRequest("Invalid service");
  }
  const n = await nextSequence("ticket");
  const slaHours = args.priority === "URGENT" ? Math.min(1, dept.slaHours) : args.priority === "HIGH" ? Math.ceil(dept.slaHours / 2) : dept.slaHours;
  const ticket = await prisma.ticket.create({
    data: {
      number: `CC-${String(100000 + n)}`,
      userId: args.userId,
      departmentId: dept.id,
      subject: args.subject,
      priority: args.priority,
      serviceId: args.serviceId ?? null,
      status: args.isStaff ? "ANSWERED" : "OPEN",
      slaDueAt: new Date(Date.now() + slaHours * 3600_000),
      messages: { create: { authorId: args.authorId, isStaff: args.isStaff, body: args.message, attachments: { create: attachData(args.files) } } },
    },
    include: { user: true, department: true },
  });
  await queueEmail("ticket.opened", ticket.user.email, { name: ticket.user.firstName, ticketNumber: ticket.number, subject: ticket.subject, department: dept.name, ticketId: ticket.id }, ticket.userId);
  return ticket;
}

export async function replyTicket(args: { ticketId: string; authorId: string; isStaff: boolean; message: string; isNote?: boolean; files?: UploadedFile[]; status?: string }) {
  const t = await prisma.ticket.findUniqueOrThrow({ where: { id: args.ticketId }, include: { user: true } });
  await prisma.ticketMessage.create({
    data: { ticketId: t.id, authorId: args.authorId, isStaff: args.isStaff, isNote: !!args.isNote, body: args.message, attachments: { create: attachData(args.files) } },
  });
  if (args.isNote) return t;
  const nextStatus = args.isStaff ? ((args.status as "ANSWERED") ?? "ANSWERED") : "CUSTOMER_REPLY";
  const updated = await prisma.ticket.update({
    where: { id: t.id },
    data: {
      status: nextStatus,
      lastReplyAt: new Date(),
      closedAt: null,
      ...(args.isStaff && !t.firstResponseAt ? { firstResponseAt: new Date() } : {}),
    },
  });
  if (args.isStaff) {
    await queueEmail("ticket.reply", t.user.email, { name: t.user.firstName, ticketNumber: t.number, subject: t.subject, message: args.message, ticketId: t.id }, t.userId);
  }
  return updated;
}

export function attachmentPath(storedAs: string) {
  if (!/^[a-f0-9]{32}$/.test(storedAs)) throw badRequest("Invalid attachment");
  return path.resolve(config.uploadDir, "tickets", storedAs);
}
