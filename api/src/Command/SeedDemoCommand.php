<?php

declare(strict_types=1);

namespace App\Command;

use App\Demo\DemoSeeder;
use Doctrine\DBAL\Connection;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/** Puts the demo café in an empty database: `php bin/console app:seed-demo`. */
#[AsCommand(name: 'app:seed-demo', description: 'Fill an empty database with the demo café.')]
final class SeedDemoCommand extends Command
{
    public function __construct(
        private readonly DemoSeeder $seeder,
        #[Autowire(service: 'doctrine.dbal.admin_connection')]
        private readonly Connection $admin,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this->addOption('force', null, InputOption::VALUE_NONE, 'Seed even though the café is already there.');
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        if ($this->seeder->isSeeded($this->admin) && !$input->getOption('force')) {
            $io->warning('The demo café is already in this database. Nothing was written.');

            return Command::SUCCESS;
        }

        $this->seeder->seed($this->admin);
        $io->success('The demo café is in. Sign in as owner@demo.local with demo-owner-2026.');

        return Command::SUCCESS;
    }
}
