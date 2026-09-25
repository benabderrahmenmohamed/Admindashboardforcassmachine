# syntax=docker/dockerfile:1.7

# ---- The dependencies, and an autoloader made from the finished source --------------------------
FROM composer:2 AS vendor
WORKDIR /app

# Only the two files the dependency graph is made of first, so editing the source does not reinstall
# it. --no-dev: the test suite, the profiler and the fixtures stay on the developer's machine.
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction

COPY . .
RUN composer dump-autoload --no-dev --optimize --classmap-authoritative

# ---- The image that runs ------------------------------------------------------------------------
FROM php:8.3-apache AS runtime
WORKDIR /var/www/html

# pdo_pgsql to reach the café, intl and zip because Symfony asks for them, opcache because this is
# the image that serves.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq-dev libicu-dev libzip-dev \
    && docker-php-ext-install -j"$(nproc)" pdo_pgsql intl zip opcache \
    && rm -rf /var/lib/apt/lists/*

COPY docker/apache.conf /etc/apache2/sites-available/000-default.conf
RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"

# The source and its vendor directory, as the stage above left them. Composer itself is not here:
# nothing in a running café installs anything.
COPY --from=vendor /app ./
COPY docker/entrypoint.sh /usr/local/bin/cafe-entrypoint
RUN chmod +x /usr/local/bin/cafe-entrypoint \
    && mkdir -p var config/jwt \
    && chown -R www-data:www-data var config/jwt

# The rest of the configuration is the deployment's: its own APP_SECRET, its own DATABASE_URL and
# DATABASE_ADMIN_URL, its own JWT_PASSPHRASE, and the origins its app is served from
# (CORS_ALLOW_ORIGIN). The committed .env holds a developer's defaults and no secret.
ENV APP_ENV=prod \
    APP_DEBUG=0 \
    MIGRATE_ON_START=1 \
    SEED_DEMO=0

EXPOSE 80
# A request with no token is answered 401 by the contract, which takes Apache, PHP, Symfony, the
# router and the firewall to say. It needs no database, so a café whose database is down is still
# told the truth about this container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD php -r 'exit(str_contains(@get_headers("http://127.0.0.1/api/v1/products")[0] ?? "", "401") ? 0 : 1);'

ENTRYPOINT ["cafe-entrypoint"]
CMD ["apache2-foreground"]
