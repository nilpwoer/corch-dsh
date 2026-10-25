# Include inside the HTTPS server; this is not a standalone server configuration.
location = /teaching-worker {
    return 308 /teaching-worker/;
}

location = /teaching-worker/ {
    return 302 /teaching-worker/health;
}

location = /teaching-worker/health {
    proxy_pass http://172.23.0.1:18083/health;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 5s;
    proxy_read_timeout 20s;
    proxy_cache off;
}

location ^~ /teaching-worker/v1/ {
    proxy_pass http://172.23.0.1:18083/v1/;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 1m;
    proxy_connect_timeout 5s;
    proxy_send_timeout 20s;
    proxy_read_timeout 20s;
    proxy_next_upstream off;
    proxy_cache off;
}

location ^~ /teaching-worker/ {
    return 404;
}
