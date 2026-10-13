// teaching-worker 是独立 Go 服务；配置只从 serve -c 指定的文件读取。
package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/fanzy531/corch-dsh/worker/internal/accounts"
	"github.com/fanzy531/corch-dsh/worker/internal/config"
	"github.com/fanzy531/corch-dsh/worker/internal/service"
	"github.com/spf13/cobra"
)

func newCommand() *cobra.Command {
	root := &cobra.Command{Use: "teaching-worker", Short: "教改访谈追问和报告 Worker", SilenceUsage: true, SilenceErrors: true}
	var path string
	serve := &cobra.Command{Use: "serve", Short: "按配置启动任务服务", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		c, err := config.Load(path)
		if err != nil {
			return err
		}
		return service.Serve(cmd.Context(), c, slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	}}
	serve.Flags().StringVarP(&path, "config", "c", "", "YAML 配置文件路径")
	_ = serve.MarkFlagRequired("config")
	root.AddCommand(serve)
	var output string
	hashCommand := &cobra.Command{Use: "hash-password", Short: "Hash a password read from stdin into a new private file", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		raw, err := io.ReadAll(io.LimitReader(cmd.InOrStdin(), 1026))
		if err != nil {
			return fmt.Errorf("password input failed")
		}
		raw = bytes.TrimSuffix(raw, []byte("\n"))
		raw = bytes.TrimSuffix(raw, []byte("\r"))
		hash, err := accounts.Hash(string(raw))
		for i := range raw {
			raw[i] = 0
		}
		if err != nil {
			return err
		}
		file, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return fmt.Errorf("cannot create private hash output")
		}
		_, writeErr := file.WriteString(hash + "\n")
		if writeErr == nil {
			writeErr = file.Sync()
		}
		closeErr := file.Close()
		if writeErr != nil {
			return fmt.Errorf("password hash write failed")
		}
		if closeErr != nil {
			return closeErr
		}
		fmt.Fprintln(cmd.OutOrStdout(), "Password hash saved to the requested file.")
		return nil
	}}
	hashCommand.Flags().StringVar(&output, "output", "", "New private output file; existing files are never overwritten")
	_ = hashCommand.MarkFlagRequired("output")
	root.AddCommand(hashCommand)
	return root
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := newCommand().ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
