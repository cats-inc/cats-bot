# API Specification

> REST/GraphQL/WebSocket API documentation.

## Overview

(Describe the API purpose and design philosophy)

## Base URL

```
Development: http://localhost:8080/api/v1
Production:  https://api.example.com/v1
```

## Authentication

(Describe authentication method: API Key, JWT, OAuth, etc.)

```bash
# Example: Bearer token
curl -H "Authorization: Bearer <token>" https://api.example.com/v1/resource
```

## Endpoints

### Resource Name

#### List Resources

```
GET /resources
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer | No | Max items to return (default: 20) |
| `offset` | integer | No | Pagination offset |

**Response:**

```json
{
  "data": [...],
  "total": 100,
  "limit": 20,
  "offset": 0
}
```

#### Get Resource

```
GET /resources/{id}
```

**Response:**

```json
{
  "id": "...",
  "name": "...",
  "created_at": "..."
}
```

#### Create Resource

```
POST /resources
```

**Request Body:**

```json
{
  "name": "...",
  "description": "..."
}
```

**Response:** `201 Created`

#### Update Resource

```
PUT /resources/{id}
```

#### Delete Resource

```
DELETE /resources/{id}
```

**Response:** `204 No Content`

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": {}
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Invalid or missing authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 422 | Invalid request body |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server error |

## Rate Limiting

(Describe rate limits if applicable)

| Tier | Requests/min | Requests/day |
|------|--------------|--------------|
| Free | 60 | 1,000 |
| Pro | 600 | 100,000 |

## WebSocket (if applicable)

```
ws://localhost:8080/ws
```

### Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `connect` | Server → Client | Connection established |
| `message` | Bidirectional | Chat message |
| `error` | Server → Client | Error notification |

## SDK Examples

### Python

```python
import httpx

async with httpx.AsyncClient() as client:
    response = await client.get(
        "http://localhost:8080/api/v1/resources",
        headers={"Authorization": f"Bearer {token}"}
    )
    data = response.json()
```

### JavaScript

```javascript
const response = await fetch('/api/v1/resources', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const data = await response.json();
```

---

*Last updated: YYYY-MM-DD*
