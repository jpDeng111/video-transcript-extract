"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// The server owns execution; closing or refreshing a window only detaches UI.
class TaskQueue {
  constructor({ filePath, resolveTitle, run }) {
    this.filePath = filePath;
    this.resolveTitle = resolveTitle;
    this.run = run;
    this.closed = true;
    this.current = null;
    this.tasks = [];
    try {
      const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(stored)) this.tasks = stored;
    } catch {}
    for (const task of this.tasks) {
      if (["running", "resolving"].includes(task.state)) task.state = "queued";
    }
  }

  list() { return this.tasks.map(task => ({ ...task })); }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.tasks, null, 2) + "\n");
    fs.renameSync(temp, this.filePath);
  }

  start() { this.closed = false; this.pump(); }

  add({ url, title = "", jobId }) {
    const existing = this.tasks.find(task => task.url === url &&
      ["queued", "resolving", "running"].includes(task.state));
    if (existing) return { task: { ...existing }, duplicate: true };
    const task = { id: randomUUID(), url, jobId, title: title || "正在获取视频标题…",
      titleResolved: Boolean(title), state: "queued", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), error: "", message: "等待处理" };
    this.tasks.push(task);
    this.save();
    this.pump();
    return { task: { ...task }, duplicate: false };
  }

  cancel(id) {
    const task = this.tasks.find(item => item.id === id);
    if (!task) throw new Error("任务不存在。");
    if (["queued", "resolving", "running"].includes(task.state)) {
      task.state = "cancelled";
      task.message = "已停止，已完成的分段保留";
      task.updatedAt = new Date().toISOString();
      this.save();
      if (this.current?.id === id) this.current.controller.abort(new Error("已停止队列任务。"));
    }
    return { ...task };
  }

  retry(id) {
    const task = this.tasks.find(item => item.id === id);
    if (!task) throw new Error("任务不存在。");
    if (!["failed", "cancelled"].includes(task.state)) throw new Error("只有失败或停止的任务可以重试。");
    if (this.current?.id === id) throw new Error("任务正在停止，请稍后重试。");
    if (this.tasks.some(item => item.id !== id && item.url === task.url &&
        ["queued", "resolving", "running"].includes(item.state))) throw new Error("该视频已在队列中。");
    task.state = "queued";
    task.error = "";
    task.message = "等待继续";
    delete task.progress;
    task.updatedAt = new Date().toISOString();
    // Retried tasks join the tail, preserving the order of pending submissions.
    this.tasks = this.tasks.filter(item => item !== task).concat(task);
    this.save();
    this.pump();
    return { ...task };
  }

  close() {
    this.closed = true;
    this.current?.controller.abort(new Error("服务正在关闭，任务将在下次启动时继续。"));
  }

  async pump() {
    if (this.closed || this.current) return;
    const task = this.tasks.find(item => item.state === "queued");
    if (!task) return;
    const controller = new AbortController();
    this.current = { id: task.id, controller };
    try {
      task.state = "resolving";
      task.updatedAt = new Date().toISOString();
      this.save();
      if (!task.titleResolved) {
        try {
          const title = await this.resolveTitle(task.url, controller.signal);
          task.title = title && title !== "Untitled Video" ? title : "未获取到视频标题";
          task.titleResolved = task.title !== "未获取到视频标题";
        } catch (error) {
          if (controller.signal.aborted) throw error;
          task.title = "未获取到视频标题";
        }
      }
      controller.signal.throwIfAborted();
      task.state = "running";
      task.message = "正在处理音频";
      this.save();
      await this.run(task, event => {
        if (task.state !== "running") return;
        if (event.title) { task.title = event.title; task.titleResolved = true; }
        if (event.type === "stage-progress") task.progress = event;
        if (event.message) task.message = event.message;
        task.updatedAt = new Date().toISOString();
        // Chunk counts/progress are observable state; durable results remain
        // owned by the existing job checkpoint/result files.
        if (event.type !== "stage-progress" || event.percent === 100) this.save();
      }, controller.signal);
      controller.signal.throwIfAborted();
      task.state = "complete";
      task.message = "已完成";
      task.error = "";
    } catch (error) {
      task.state = task.state === "cancelled" ? "cancelled" :
        this.closed ? "queued" : controller.signal.aborted ? "cancelled" : "failed";
      task.error = task.state === "failed" ? error.message : "";
      task.message = task.state === "queued" ? "等待恢复" : task.state === "cancelled" ? "已停止，已完成的分段保留" : "处理失败";
    } finally {
      task.updatedAt = new Date().toISOString();
      this.current = null;
      this.save();
      if (!this.closed) queueMicrotask(() => this.pump());
    }
  }
}

module.exports = { TaskQueue };
