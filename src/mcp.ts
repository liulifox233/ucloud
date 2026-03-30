import { IRequest } from 'itty-router';
import { UserInfo } from '@byrdocs/bupt-auth';
import { getToken } from './auth';
import { getUndoneList, getDetail, searchCourses, getResource } from './crawler';
import { UndoneListResponse } from './types';
import { isNumeric, getInfoWithCache } from './worker';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

const TOOLS = [
  {
    name: 'get_undone_list',
    description:
      'Get a list of all pending assignments/tasks for the current user, including assignment names, deadlines, and course info.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_homework_detail',
    description:
      'Get detailed information about an assignment by ID, including title, content, attachments, and course info. The ID can be obtained from the activityId field in get_undone_list.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The activityId of the assignment, retrieved from get_undone_list results',
        },
      },
      required: ['id'],
    },
  },
];

const TOOL_KIND: Record<number, string> = {
  2: 'survey',
  3: 'assignment',
  4: 'exam',
};

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactUndoneList(data: any) {
  const items = Array.isArray(data?.undoneList)
    ? data.undoneList.map((item: any) => ({
        id: item.activityId,
        title: item.activityName,
        kind: TOOL_KIND[item.type] ?? String(item.type),
        dueAt: item.endTime,
        course: item.courseInfo?.name,
        teachers: item.courseInfo?.teachers,
      }))
    : [];

  return {
    total: typeof data?.undoneNum === 'number' ? data.undoneNum : items.length,
    items,
  };
}

function compactHomeworkDetail(data: any) {
  const attachmentsFromResource = Array.isArray(data?.resource)
    ? data.resource.map((item: any) => ({
        id: item.id,
        name: item.name,
        url: item.url,
      }))
    : [];

  const attachments =
    attachmentsFromResource.length > 0
      ? attachmentsFromResource
      : Array.isArray(data?.assignmentResource)
        ? data.assignmentResource.map((item: any) => ({
            id: item.resourceId,
            name: item.resourceName,
            type: item.resourceType,
          }))
        : [];

  return {
    id: data?.id,
    title: data?.assignmentTitle,
    content: stripHtml(data?.assignmentContent ?? ''),
    comment: data?.assignmentComment || undefined,
    course: data?.courseInfo?.name,
    teachers: data?.courseInfo?.teachers,
    className: data?.className || undefined,
    startAt: data?.assignmentBeginTime,
    endAt: data?.assignmentEndTime,
    allowLateSubmission: Boolean(data?.isOvertimeCommit),
    attachments,
  };
}

function compactToolResult(name: string, data: any) {
  if (name === 'get_undone_list') return compactUndoneList(data);
  if (name === 'get_homework_detail') return compactHomeworkDetail(data);
  return data;
}

async function getUserFromToken(token: string, env: Env): Promise<UserInfo> {
  const row = await env.DB.prepare('SELECT username FROM mcp_tokens WHERE token = ?').bind(token).first<{ username: string }>();
  if (!row) throw new Error('Invalid token');
  return getToken(row.username, null, env.DB, env.OCR_TOKEN);
}

async function callGetUndoneList(userInfo: UserInfo, env: Env): Promise<object> {
  const res: UndoneListResponse = await getUndoneList(userInfo);
  if (!res.success) throw new Error(res.msg);

  function isNumericLocal(str: string) {
    if (str.length === 0) return false;
    for (let i = 0; i < str.length; i++) {
      if (!Number.isInteger(Number(str[i]))) return false;
    }
    return true;
  }

  const ids = res.data.undoneList
    .map((item) => item.activityId)
    .filter((id) => isNumericLocal(id))
    .join(',');

  const inCache: Array<{ id: string; info: string }> = ids.length
    ? ((await env.DB.prepare(`SELECT id,info FROM homeworks WHERE id IN (${ids})`).raw()) as string[][]).map((row: string[]) => ({
        id: row[0],
        info: row[1],
      }))
    : [];

  const inCacheMap = new Map(inCache.map((x) => [x.id, x]));
  const notInCache = res.data.undoneList.filter((item) => !inCacheMap.has(item.activityId));
  const notInCacheMap = new Map(notInCache.map((x) => [x.activityId, x]));

  if (notInCache.length > 0) {
    const coursesInfo = await searchCourses(userInfo, notInCache);
    const stmt = env.DB.prepare('INSERT INTO homeworks (id, info) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET info = excluded.info');
    const coursesInfoArr = Object.entries(coursesInfo);
    if (coursesInfoArr.length > 0) {
      const batch = coursesInfoArr.map(([id, info]) =>
        stmt.bind(
          id,
          JSON.stringify({
            ...info,
            activityName: notInCacheMap.get(id)?.activityName,
            endTime: notInCacheMap.get(id)?.endTime,
          }),
        ),
      );
      await env.DB.batch(batch);
    }
    res.data.undoneList = res.data.undoneList.map((item) => ({
      ...item,
      courseInfo: inCacheMap.has(item.activityId) ? JSON.parse(inCacheMap.get(item.activityId)!.info) : coursesInfo[item.activityId],
    }));
  } else {
    res.data.undoneList = res.data.undoneList.map((item) => ({
      ...item,
      courseInfo: JSON.parse(inCacheMap.get(item.activityId)?.info || '{}'),
    }));
  }

  return res.data;
}

async function callGetHomeworkDetail(id: string, userInfo: UserInfo, env: Env): Promise<object> {
  if (!isNumeric(id)) throw new Error('Invalid id');
  const res = await getDetail(id, userInfo);
  if (!res.success) throw new Error(res.msg);
  res.data.courseInfo = await getInfoWithCache(userInfo, id, res.data.assignmentTitle, env.DB);
  if (res.data.assignmentResource.length) {
    const resource = await getResource(userInfo, res.data.assignmentResource);
    if (resource) res.data.resource = resource;
  }
  return res.data;
}

async function dispatch(msg: JsonRpcRequest, userInfo: UserInfo, env: Env): Promise<JsonRpcResponse | null> {
  const { jsonrpc, id, method, params } = msg;

  if (method === 'notifications/initialized') return null;

  function ok(result: any): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }
  function err(code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  if (method === 'initialize') {
    return ok({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'ucloud-mcp', version: '1.0.0' },
    });
  }

  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name: string = params?.name;
    const args = params?.arguments ?? {};
    try {
      let data: object;
      if (name === 'get_undone_list') {
        data = await callGetUndoneList(userInfo, env);
      } else if (name === 'get_homework_detail') {
        if (!args.id || typeof args.id !== 'string') {
          return err(-32602, 'Invalid params: id is required');
        }
        data = await callGetHomeworkDetail(args.id, userInfo, env);
      } else {
        return err(-32601, `Unknown tool: ${name}`);
      }
      return ok({ content: [{ type: 'text', text: JSON.stringify(compactToolResult(name, data)) }] });
    } catch (e: any) {
      return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }

  return err(-32601, 'Method not found');
}

export async function handleMcp(request: IRequest, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return new Response('Unauthorized: missing token', { status: 401 });
  }

  let userInfo: UserInfo;
  try {
    userInfo = await getUserFromToken(token, env);
  } catch {
    return new Response('Unauthorized: invalid token', { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    const errResp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    };
    return new Response(JSON.stringify(errResp), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const jsonHeaders = { 'Content-Type': 'application/json' };

  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map((msg) => dispatch(msg, userInfo, env)));
    const valid = responses.filter(Boolean);
    if (valid.length === 0) return new Response(null, { status: 202 });
    return new Response(JSON.stringify(valid), { headers: jsonHeaders });
  }

  const response = await dispatch(body, userInfo, env);
  if (response === null) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(response), { headers: jsonHeaders });
}
