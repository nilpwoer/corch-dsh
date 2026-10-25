# Include inside the existing Worker HTTPS server after operator approval.
# Match client_max_body_size to the deployed Worker upload limit.
location ^~ /publish/api/ {
    proxy_pass http://172.23.0.1:18083/publish/api/;
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
    access_log off;
}
